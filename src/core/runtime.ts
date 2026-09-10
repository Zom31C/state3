import type { Environment } from '../envs/env.js';
import type { LLMProvider } from '../llm/provider.js';
import type { ParsedStep } from './parser.js';
import { parseStepResponse, ParseError } from './parser.js';
import { buildSkillStatePrompt } from './prompts.js';
import type { Skill } from './skill.js';
import { StateStore } from './state.js';
import type { StateDict } from './types.js';
import { validatePatch } from './validator.js';

export interface RuntimeOptions {
  skill: Skill;
  env: Environment;
  provider: LLMProvider;
  /**
   * Retries after a failed response. A step may spend up to 1 + maxRetries
   * LLM calls. Paper-default: 3.
   */
  maxRetries?: number;
  /**
   * Use provider-native structured output (JSON-schema constrained decoding)
   * for step responses. The paper's recommendation for small local models:
   * eliminates syntax-level JSON errors. Reasoning is suppressed (discarded anyway).
   */
  structuredOutput?: boolean;
}

/** Constrained-decoding schema of a SKILL.state step response. */
export const STEP_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    state_patch: { type: 'object' },
    action: { type: 'string' },
  },
  required: ['state_patch', 'action'],
};

export interface StepError {
  /** Parse error code or validation category. */
  category: string;
  message: string;
}

export interface StepRecord {
  step: number;
  valid: boolean;
  /** Set only for valid steps. */
  action?: string;
  /** Set only for valid steps. */
  patch?: StateDict;
  retries: number;
  errors: StepError[];
}

export interface TokenTally {
  prompt: number;
  completion: number;
  total: number;
}

export interface RunResult {
  steps: StepRecord[];
  finalState: StateDict;
  validSteps: number;
  invalidSteps: number;
  totalRetries: number;
  llmCalls: number;
  /** Sum of prompt string lengths over every LLM call. */
  promptChars: number;
  tokens: TokenTally;
  /** Failed-attempt counts by error category (paper error-mode taxonomy). */
  errorCounts: Record<string, number>;
}

type ApplyResult = { ok: true; parsed: ParsedStep } | { ok: false; error: StepError };

/**
 * SKILL.state runtime loop (Algorithm 1 of arXiv:2608.26263):
 * prompt (P, Σ, O) → (R, ΔΣ, a) → validate ΔΣ → merge → execute a.
 * Reasoning traces are discarded; the prompt footprint stays O(1) per step.
 */
export class SkillStateRuntime {
  private readonly skill: Skill;
  private readonly env: Environment;
  private readonly provider: LLMProvider;
  private readonly maxRetries: number;
  private readonly structuredOutput: boolean;

  constructor(options: RuntimeOptions) {
    this.skill = options.skill;
    this.env = options.env;
    this.provider = options.provider;
    this.maxRetries = options.maxRetries ?? 3;
    this.structuredOutput = options.structuredOutput ?? false;
  }

  async run(horizon: number): Promise<RunResult> {
    if (!Number.isInteger(horizon) || horizon < 0) {
      throw new Error(`horizon must be a non-negative integer, got ${horizon}`);
    }

    const store = new StateStore(this.skill.initialState);
    const result: RunResult = {
      steps: [],
      finalState: store.state,
      validSteps: 0,
      invalidSteps: 0,
      totalRetries: 0,
      llmCalls: 0,
      promptChars: 0,
      tokens: { prompt: 0, completion: 0, total: 0 },
      errorCounts: {},
    };

    for (let step = 0; step < horizon; step++) {
      if (this.env.done === true) break;
      const record = await this.runStep(store, result);
      if (record.valid) result.validSteps += 1;
      else result.invalidSteps += 1;
      result.steps.push(record);
    }

    result.finalState = store.state;
    return result;
  }

  private async runStep(store: StateStore, result: RunResult): Promise<StepRecord> {
    const record: StepRecord = { step: result.steps.length, valid: false, retries: 0, errors: [] };
    let prompt = buildSkillStatePrompt(this.skill, store.state, this.env.observe());

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const response = await this.provider.complete(
        prompt,
        this.structuredOutput ? { jsonSchema: STEP_JSON_SCHEMA } : {},
      );
      result.llmCalls += 1;
      result.promptChars += prompt.length;
      result.tokens.prompt += response.usage.promptTokens;
      result.tokens.completion += response.usage.completionTokens;
      result.tokens.total += response.usage.totalTokens;

      const applied = this.tryApply(store, response.text);
      if (applied.ok) {
        record.valid = true;
        record.action = applied.parsed.action;
        record.patch = applied.parsed.statePatch;
        return record;
      }

      record.errors.push(applied.error);
      result.errorCounts[applied.error.category] =
        (result.errorCounts[applied.error.category] ?? 0) + 1;
      if (attempt < this.maxRetries) {
        record.retries += 1;
        result.totalRetries += 1;
        prompt +=
          `\n\nYour previous response was invalid (${applied.error.category}): ` +
          `${applied.error.message}. Respond again in the exact required format ` +
          'with a corrected JSON block.';
      }
    }

    return record;
  }

  /** Parses, validates, and applies the response. Rolls nothing back: an invalid patch is never applied. */
  private tryApply(store: StateStore, text: string): ApplyResult {
    let parsed: ParsedStep;
    try {
      parsed = parseStepResponse(text);
    } catch (err) {
      if (err instanceof ParseError) {
        return { ok: false, error: { category: err.code, message: err.message } };
      }
      throw err;
    }

    const validation = validatePatch(this.skill, store.state, parsed.statePatch);
    if (!validation.ok) {
      return { ok: false, error: { category: validation.category, message: validation.message } };
    }

    store.applyPatch(parsed.statePatch);
    this.env.step(parsed.action);
    return { ok: true, parsed };
  }
}
