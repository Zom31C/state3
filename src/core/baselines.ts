import type { Environment } from '../envs/env.js';
import type { LLMProvider, TokenUsage } from '../llm/provider.js';
import { parseActionResponse } from './baseline-parser.js';
import { ParseError } from './parser.js';
import {
  buildMemoryRuntimePrompt,
  buildPromptRuntimePrompt,
  buildStatefulRuntimePrompt,
  formatTranscript,
  type TranscriptEntry,
} from './prompts.js';
import type { RunResult, StepRecord } from './runtime.js';
import type { Skill } from './skill.js';
import { mergeState } from './state.js';
import type { StateDict } from './types.js';

export type BaselineKind = 'prompt' | 'memory' | 'stateful';

/** Deterministic framework-side state update from an executed action (Stateful baseline). */
export type ActionStateUpdater = (state: StateDict, action: string) => StateDict;

export interface BaselineOptions {
  skill: Skill;
  env: Environment;
  provider: LLMProvider;
  kind: BaselineKind;
  /** Retries after a failed response; a step spends up to 1 + maxRetries calls. Default 3. */
  maxRetries?: number;
  /** Memory baseline: transcript entries kept verbatim. Paper: 3. */
  memoryWindow?: number;
  /** Memory baseline: fold pending entries into the summary every N departures. Default 5. */
  summarizeEvery?: number;
  /** Required for kind 'stateful'. */
  actionStateUpdater?: ActionStateUpdater;
}

export const INVALID_ACTION_PLACEHOLDER = '(no valid action)';

const NOTHING_SUMMARIZED = 'Nothing summarized yet.';

/** Periodic NL-compression call of the Memory baseline (paper A.2: "updated periodically"). */
export function buildSummaryPrompt(
  skill: Skill,
  previousSummary: string,
  entries: readonly TranscriptEntry[],
): string {
  return [
    `You are summarizing the execution history of the "${skill.name}" skill for an agent with a small context window.`,
    '',
    'Skill instructions:',
    skill.instructions,
    '',
    'Previous summary:',
    previousSummary === '' ? '(none)' : previousSummary,
    '',
    'New steps to fold into the summary:',
    formatTranscript(entries),
    '',
    'Write the updated summary in plain text. Keep everything still needed to act correctly in future steps (e.g. which items are stored where, pending obligations) and drop superseded details. Respond with the summary text only.',
  ].join('\n');
}

/**
 * Baseline runtimes of the paper (Appendix A.1–A.3) over the shared env/skill
 * contracts: Prompt (ReAct, append-only transcript), Memory (NL summary +
 * verbatim window), Stateful (state block PLUS the full transcript).
 */
export class BaselineRuntime {
  private readonly skill: Skill;
  private readonly env: Environment;
  private readonly provider: LLMProvider;
  private readonly kind: BaselineKind;
  private readonly maxRetries: number;
  private readonly memoryWindow: number;
  private readonly summarizeEvery: number;
  private readonly actionStateUpdater: ActionStateUpdater;

  constructor(options: BaselineOptions) {
    if (options.kind === 'stateful' && options.actionStateUpdater === undefined) {
      throw new Error("BaselineRuntime: kind 'stateful' requires actionStateUpdater");
    }
    this.skill = options.skill;
    this.env = options.env;
    this.provider = options.provider;
    this.kind = options.kind;
    this.maxRetries = options.maxRetries ?? 3;
    this.memoryWindow = options.memoryWindow ?? 3;
    this.summarizeEvery = options.summarizeEvery ?? 5;
    if (this.memoryWindow < 1 || this.summarizeEvery < 1) {
      throw new Error('memoryWindow and summarizeEvery must be >= 1');
    }
    this.actionStateUpdater = options.actionStateUpdater ?? ((state) => state);
  }

  async run(horizon: number): Promise<RunResult> {
    if (!Number.isInteger(horizon) || horizon < 0) {
      throw new Error(`horizon must be a non-negative integer, got ${horizon}`);
    }

    const entries: TranscriptEntry[] = [];
    const result = createRunResult();
    let state = mergeState(this.skill.initialState, {});
    let summary = '';
    let summarizedCount = 0;

    for (let step = 0; step < horizon; step++) {
      if (this.env.done === true) break;
      const observation = this.env.observe();
      const record: StepRecord = {
        step: result.steps.length,
        valid: false,
        retries: 0,
        errors: [],
      };
      let prompt = this.buildStepPrompt(state, summary, entries, summarizedCount, observation);

      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        const response = await this.provider.complete(prompt);
        tally(result, prompt.length, response.usage);

        let action: string;
        let reasoning: string;
        try {
          const parsed = parseActionResponse(response.text);
          action = parsed.action;
          reasoning = parsed.reasoning;
        } catch (err) {
          if (!(err instanceof ParseError)) throw err;
          record.errors.push({ category: err.code, message: err.message });
          result.errorCounts[err.code] = (result.errorCounts[err.code] ?? 0) + 1;
          if (attempt < this.maxRetries) {
            record.retries += 1;
            result.totalRetries += 1;
            prompt +=
              `\n\nYour previous response was invalid (${err.code}): ${err.message} ` +
              'Respond again, ending with the corrected "Action:" line.';
          }
          continue;
        }

        record.valid = true;
        record.action = action;
        this.env.step(action);
        if (this.kind === 'stateful') {
          state = this.actionStateUpdater(state, action);
        }
        entries.push({ observation, reasoning, action });
        if (this.kind === 'memory') {
          const folded = await this.foldPendingIntoSummary(
            entries,
            summarizedCount,
            summary,
            result,
          );
          summary = folded.summary;
          summarizedCount = folded.summarizedCount;
        }
        break;
      }

      if (record.valid) {
        result.validSteps += 1;
      } else {
        result.invalidSteps += 1;
        entries.push({ observation, reasoning: '', action: INVALID_ACTION_PLACEHOLDER });
      }
      result.steps.push(record);
    }

    result.finalState = this.kind === 'stateful' ? state : {};
    return result;
  }

  private buildStepPrompt(
    state: StateDict,
    summary: string,
    entries: readonly TranscriptEntry[],
    summarizedCount: number,
    observation: string,
  ): string {
    switch (this.kind) {
      case 'prompt':
        return buildPromptRuntimePrompt(this.skill, entries, observation);
      case 'memory':
        return buildMemoryRuntimePrompt(
          this.skill,
          summary === '' ? NOTHING_SUMMARIZED : summary,
          entries.slice(summarizedCount),
          observation,
        );
      case 'stateful':
        return buildStatefulRuntimePrompt(this.skill, state, entries, observation);
      default: {
        const exhaustive: never = this.kind;
        throw new Error(`Unknown baseline kind: ${String(exhaustive)}`);
      }
    }
  }

  private async foldPendingIntoSummary(
    entries: readonly TranscriptEntry[],
    summarizedCount: number,
    summary: string,
    result: RunResult,
  ): Promise<{ summary: string; summarizedCount: number }> {
    const windowStart = Math.max(summarizedCount, entries.length - this.memoryWindow);
    const pendingCount = windowStart - summarizedCount;
    if (pendingCount < this.summarizeEvery) {
      return { summary, summarizedCount };
    }

    const pending = entries.slice(summarizedCount, windowStart);
    const prompt = buildSummaryPrompt(this.skill, summary, pending);
    const response = await this.provider.complete(prompt);
    tally(result, prompt.length, response.usage);
    return {
      summary: response.text.trim(),
      summarizedCount: summarizedCount + pending.length,
    };
  }
}

function createRunResult(): RunResult {
  return {
    steps: [],
    finalState: {},
    validSteps: 0,
    invalidSteps: 0,
    totalRetries: 0,
    llmCalls: 0,
    promptChars: 0,
    tokens: { prompt: 0, completion: 0, total: 0 },
    errorCounts: {},
  };
}

function tally(result: RunResult, promptChars: number, usage: TokenUsage): void {
  result.llmCalls += 1;
  result.promptChars += promptChars;
  result.tokens.prompt += usage.promptTokens;
  result.tokens.completion += usage.completionTokens;
  result.tokens.total += usage.totalTokens;
}
