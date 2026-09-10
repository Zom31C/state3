import { describe, expect, it } from 'vitest';
import type { EpisodeDeps } from '../src/cli.js';
import { parseArgs, runEpisode } from '../src/cli.js';
import { WarehouseEnv } from '../src/envs/warehouse.js';
import type { LLMProvider, LLMResponse } from '../src/llm/provider.js';
import { applyWarehouseAction, warehouseSkill } from '../src/skills/warehouse.js';

const USAGE = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

function makePatchOracleProvider(env: WarehouseEnv): LLMProvider {
  return {
    kind: 'oracle',
    model: 'mock',
    async complete(_prompt: string): Promise<LLMResponse> {
      const index = env.judgements.length;
      const expected = env.expectedActionFor(index);
      const [verb, ...rest] = expected.split(' ');
      const shelf = rest[rest.length - 1] ?? '';
      const patch: Record<string, string | null> = {
        [shelf]: verb === 'STORE' ? (rest[0] ?? '') : null,
      };
      const body = JSON.stringify({ state_patch: patch, action: expected });
      return {
        text: `Ground-truth step.\n\`\`\`json\n${body}\n\`\`\``,
        model: 'mock',
        usage: { ...USAGE },
      };
    },
  };
}

function makeActionOracleProvider(env: WarehouseEnv): LLMProvider {
  return {
    kind: 'oracle',
    model: 'mock',
    async complete(_prompt: string): Promise<LLMResponse> {
      const expected = env.expectedActionFor(env.judgements.length);
      return { text: `Reasoning: ok\nAction: ${expected}`, model: 'mock', usage: { ...USAGE } };
    },
  };
}

function makeJunkProvider(): LLMProvider {
  return {
    kind: 'junk',
    model: 'mock',
    async complete(_prompt: string): Promise<LLMResponse> {
      return {
        text: 'no json here',
        model: 'mock',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
  };
}

function makeDeps(provider: LLMProvider, env: WarehouseEnv): EpisodeDeps {
  return {
    createProvider: () => provider,
    createEnv: () => env,
    createSkill: warehouseSkill,
    createActionUpdater: () => applyWarehouseAction,
  };
}

describe('parseArgs', () => {
  it('applies paper defaults', () => {
    expect(parseArgs([])).toMatchObject({ horizon: 100, seed: 42, maxRetries: 3 });
  });

  it('parses every flag', () => {
    expect(
      parseArgs([
        '--horizon',
        '50',
        '--seed',
        '7',
        '--max-retries',
        '1',
        '--structured',
        '--provider',
        'ollama',
        '--model',
        'm1',
        '--out',
        'results/x.json',
        '--quiet',
      ]),
    ).toEqual({
      horizon: 50,
      seed: 7,
      maxRetries: 1,
      structured: true,
      provider: 'ollama',
      model: 'm1',
      out: 'results/x.json',
      quiet: true,
    });
  });

  it('parses runtime selection and matrix flags', () => {
    expect(
      parseArgs([
        '--runtime',
        'memory',
        '--horizons',
        '50,100',
        '--seeds',
        '1,2,3',
        '--memory-window',
        '2',
        '--summarize-every',
        '4',
      ]),
    ).toEqual({
      horizon: 100,
      seed: 42,
      maxRetries: 3,
      runtime: 'memory',
      horizons: [50, 100],
      seeds: [1, 2, 3],
      memoryWindow: 2,
      summarizeEvery: 4,
    });
  });

  it('rejects unknown flags, missing values, bad numbers, and unknown runtimes', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown argument/);
    expect(() => parseArgs(['--horizon'])).toThrow(/Missing value/);
    expect(() => parseArgs(['--horizon', 'abc'])).toThrow(/integer/);
    expect(() => parseArgs(['--horizon', '0'])).toThrow(/>= 1/);
    expect(() => parseArgs(['--seed', '-1'])).toThrow(/>= 0/);
    expect(() => parseArgs(['--runtime', 'react'])).toThrow(/Unknown runtime/);
    expect(() => parseArgs(['--horizons', '5,x'])).toThrow(/integer/);
    expect(() => parseArgs(['--seeds', '1,,2'])).toThrow(/comma-separated/);
  });
});

describe('runEpisode', () => {
  it('scores 1.0 accuracy against the skillstate oracle provider', async () => {
    const env = new WarehouseEnv({ horizon: 5, seed: 42 });
    const provider = makePatchOracleProvider(env);

    const report = await runEpisode(
      { horizon: 5, seed: 42, maxRetries: 3 },
      makeDeps(provider, env),
    );

    expect(report.skill).toBe('warehouse');
    expect(report.runtime).toBe('skillstate');
    expect(report.provider).toBe('oracle');
    expect(report.metrics.accuracy).toBe(1);
    expect(report.metrics.judged).toBe(5);
    expect(report.metrics.correctActions).toBe(5);
    expect(report.metrics.validSteps).toBe(5);
    expect(report.metrics.invalidSteps).toBe(0);
    expect(report.metrics.totalRetries).toBe(0);
    expect(report.metrics.llmCalls).toBe(5);
    expect(report.metrics.tokens.total).toBe(75);
    expect(report.judgements).toHaveLength(5);
    expect(report.judgements.every((j) => j.correct)).toBe(true);
  });

  it('runs the prompt baseline via the action oracle', async () => {
    const env = new WarehouseEnv({ horizon: 5, seed: 42 });
    const provider = makeActionOracleProvider(env);

    const report = await runEpisode(
      { horizon: 5, seed: 42, maxRetries: 3, runtime: 'prompt' },
      makeDeps(provider, env),
    );

    expect(report.runtime).toBe('prompt');
    expect(report.metrics.accuracy).toBe(1);
    expect(report.metrics.llmCalls).toBe(5);
  });

  it('runs the stateful baseline via the action oracle', async () => {
    const env = new WarehouseEnv({ horizon: 5, seed: 42 });
    const provider = makeActionOracleProvider(env);

    const report = await runEpisode(
      { horizon: 5, seed: 42, maxRetries: 3, runtime: 'stateful' },
      makeDeps(provider, env),
    );

    expect(report.runtime).toBe('stateful');
    expect(report.metrics.accuracy).toBe(1);
  });

  it('records invalid steps without judging when the provider never answers in format', async () => {
    const env = new WarehouseEnv({ horizon: 5, seed: 42 });

    const report = await runEpisode(
      { horizon: 5, seed: 42, maxRetries: 0 },
      makeDeps(makeJunkProvider(), env),
    );

    expect(report.metrics.validSteps).toBe(0);
    expect(report.metrics.invalidSteps).toBe(5);
    expect(report.metrics.judged).toBe(0);
    expect(report.metrics.accuracy).toBe(0);
    expect(report.metrics.llmCalls).toBe(5);
    expect(report.judgements).toHaveLength(0);
    expect(report.steps.every((s) => !s.valid && s.errors.length > 0)).toBe(true);
  });
});
