import { resolveProviderConfig } from './config.js';
import type { BaselineKind } from './core/baselines.js';
import { BaselineRuntime } from './core/baselines.js';
import type { RunResult, StepRecord, TokenTally } from './core/runtime.js';
import { SkillStateRuntime } from './core/runtime.js';
import type { Skill } from './core/skill.js';
import type { StepJudgement, WarehouseEnv } from './envs/warehouse.js';
import { WarehouseEnv as WarehouseEnvImpl } from './envs/warehouse.js';
import { createProvider as createLLMProvider } from './llm/index.js';
import type { LLMProvider } from './llm/provider.js';
import type { ActionStateUpdater } from './core/baselines.js';
import { applyWarehouseAction, warehouseSkill } from './skills/warehouse.js';

export type RuntimeKind = 'skillstate' | BaselineKind;

export const ALL_RUNTIMES: readonly RuntimeKind[] = ['skillstate', 'prompt', 'memory', 'stateful'];

export interface RunOptions {
  horizon: number;
  seed: number;
  maxRetries: number;
  runtime?: RuntimeKind;
  memoryWindow?: number;
  summarizeEvery?: number;
  /** Provider-native structured output; applies to the skillstate runtime only. */
  structured?: boolean;
  provider?: string;
  model?: string;
  out?: string;
  quiet?: boolean;
  /** Matrix mode (CLI-level; ignored by runEpisode). */
  horizons?: number[];
  seeds?: number[];
}

export interface EpisodeMetrics {
  accuracy: number;
  judged: number;
  correctActions: number;
  validSteps: number;
  invalidSteps: number;
  totalRetries: number;
  llmCalls: number;
  promptCharsTotal: number;
  promptCharsAvg: number;
  tokens: TokenTally;
  /** Failed-attempt counts by error category (paper error-mode taxonomy). */
  errorCounts: Record<string, number>;
}

export interface EpisodeReport {
  skill: string;
  runtime: RuntimeKind;
  horizon: number;
  seed: number;
  provider: string;
  model: string;
  metrics: EpisodeMetrics;
  steps: StepRecord[];
  judgements: StepJudgement[];
}

export interface EpisodeDeps {
  createProvider: () => LLMProvider;
  createEnv: (options: { horizon: number; seed: number }) => WarehouseEnv;
  createSkill: () => Skill;
  createActionUpdater: () => ActionStateUpdater;
}

const defaultDeps: EpisodeDeps = {
  createProvider: () => createLLMProvider(resolveProviderConfig()),
  createEnv: (options) => new WarehouseEnvImpl(options),
  createSkill: warehouseSkill,
  createActionUpdater: () => applyWarehouseAction,
};

export async function runEpisode(
  options: RunOptions,
  deps: EpisodeDeps = defaultDeps,
): Promise<EpisodeReport> {
  const skill = deps.createSkill();
  const env = deps.createEnv({ horizon: options.horizon, seed: options.seed });
  const provider = deps.createProvider();
  const kind = options.runtime ?? 'skillstate';

  const run: RunResult =
    kind === 'skillstate'
      ? await new SkillStateRuntime({
          skill,
          env,
          provider,
          maxRetries: options.maxRetries,
          ...(options.structured !== undefined ? { structuredOutput: options.structured } : {}),
        }).run(options.horizon)
      : await new BaselineRuntime({
          skill,
          env,
          provider,
          kind,
          maxRetries: options.maxRetries,
          ...(options.memoryWindow !== undefined ? { memoryWindow: options.memoryWindow } : {}),
          ...(options.summarizeEvery !== undefined
            ? { summarizeEvery: options.summarizeEvery }
            : {}),
          actionStateUpdater: deps.createActionUpdater(),
        }).run(options.horizon);

  const score = env.score();
  return {
    skill: skill.name,
    runtime: kind,
    horizon: options.horizon,
    seed: options.seed,
    provider: provider.kind,
    model: provider.model,
    metrics: {
      accuracy: score.accuracy,
      judged: score.judged,
      correctActions: score.correct,
      validSteps: run.validSteps,
      invalidSteps: run.invalidSteps,
      totalRetries: run.totalRetries,
      llmCalls: run.llmCalls,
      promptCharsTotal: run.promptChars,
      promptCharsAvg: run.llmCalls > 0 ? run.promptChars / run.llmCalls : 0,
      tokens: run.tokens,
      errorCounts: run.errorCounts,
    },
    steps: run.steps,
    judgements: [...env.judgements],
  };
}
