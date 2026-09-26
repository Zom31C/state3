import { describe, expect, it } from 'vitest';
import type { EpisodeDeps, EpisodeMetrics } from '../src/episode.js';
import { WarehouseEnv } from '../src/envs/warehouse.js';
import type { LLMProvider, LLMResponse } from '../src/llm/provider.js';
import type { MatrixCell } from '../src/matrix.js';
import { runMatrix, summarizeMatrix } from '../src/matrix.js';
import { applyWarehouseAction, warehouseSkill } from '../src/skills/warehouse.js';

const USAGE = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

function reply(text: string): LLMResponse {
  return { text, model: 'mock', usage: { ...USAGE } };
}

/** Oracle for every runtime kind: answers in the format each prompt asks for. */
function makeOracleProvider(holder: { env?: WarehouseEnv }): LLMProvider {
  return {
    kind: 'oracle',
    model: 'mock',
    async complete(prompt: string): Promise<LLMResponse> {
      const env = holder.env;
      if (env === undefined) throw new Error('oracle called before env creation');
      if (prompt.includes('Write the updated summary')) {
        return reply('Compact summary of past steps.');
      }
      const expected = env.expectedActionFor(env.judgements.length);
      if (prompt.includes('Respond exactly in the following format:\n[reasoning]')) {
        const [verb, ...rest] = expected.split(' ');
        const shelf = rest[rest.length - 1] ?? '';
        const patch: Record<string, string | null> = {
          [shelf]: verb === 'STORE' ? (rest[0] ?? '') : null,
        };
        return reply(
          `Reasoning.\n\`\`\`json\n${JSON.stringify({ state_patch: patch, action: expected })}\n\`\`\``,
        );
      }
      return reply(`Reasoning: ok\nAction: ${expected}`);
    },
  };
}

function makeOracleDeps(): EpisodeDeps {
  const holder: { env?: WarehouseEnv } = {};
  return {
    createProvider: () => makeOracleProvider(holder),
    createEnv: (options) => {
      const env = new WarehouseEnv(options);
      holder.env = env;
      return env;
    },
    createSkill: warehouseSkill,
    createActionUpdater: () => applyWarehouseAction,
  };
}

type CellOverrides = Omit<Partial<MatrixCell>, 'metrics'> & { metrics?: Partial<EpisodeMetrics> };

function makeCell(overrides: CellOverrides = {}): MatrixCell {
  const metrics: EpisodeMetrics = {
    accuracy: 0.5,
    judged: 10,
    correctActions: 5,
    validSteps: 10,
    invalidSteps: 0,
    totalRetries: 0,
    llmCalls: 10,
    promptCharsTotal: 100,
    promptCharsAvg: 10,
    tokens: { prompt: 1, completion: 2, total: 3 },
    errorCounts: {},
  };
  const { metrics: metricsOverrides, ...rest } = overrides;
  return {
    runtime: 'prompt',
    horizon: 10,
    seed: 1,
    provider: 'p',
    model: 'm',
    ...rest,
    metrics: { ...metrics, ...(metricsOverrides ?? {}) },
  };
}

describe('runMatrix', () => {
  it('runs every runtime × horizon × seed cell with oracle accuracy 1', async () => {
    const cells = await runMatrix(
      {
        runtimes: ['state3', 'prompt', 'memory', 'stateful'],
        horizons: [4],
        seeds: [42, 43],
        maxRetries: 1,
      },
      makeOracleDeps(),
    );

    expect(cells).toHaveLength(8);
    for (const cell of cells) {
      expect(cell.metrics.accuracy).toBe(1);
      expect(cell.metrics.judged).toBe(4);
      expect(cell.metrics.invalidSteps).toBe(0);
      expect(cell.provider).toBe('oracle');
    }
    expect(cells.map((c) => c.runtime)).toEqual([
      'state3',
      'state3',
      'prompt',
      'prompt',
      'memory',
      'memory',
      'stateful',
      'stateful',
    ]);
    expect(cells.map((c) => c.seed)).toEqual([42, 43, 42, 43, 42, 43, 42, 43]);
  });
});

describe('summarizeMatrix', () => {
  it('groups cells by runtime and horizon and averages metrics', () => {
    const cells = [
      makeCell({
        metrics: {
          accuracy: 0.5,
          promptCharsAvg: 10,
          tokens: { prompt: 1, completion: 2, total: 3 },
          invalidSteps: 0,
        },
      }),
      makeCell({
        seed: 2,
        metrics: {
          accuracy: 0.7,
          promptCharsAvg: 20,
          tokens: { prompt: 1, completion: 2, total: 7 },
          invalidSteps: 1,
        },
      }),
      makeCell({ runtime: 'state3', metrics: { accuracy: 0.9 } }),
    ];

    const rows = summarizeMatrix(cells);

    expect(rows).toHaveLength(2);
    const promptRow = rows[0];
    expect(promptRow?.runtime).toBe('prompt');
    expect(promptRow?.horizon).toBe(10);
    expect(promptRow?.runs).toBe(2);
    expect(promptRow?.avgAccuracy).toBeCloseTo(0.6);
    expect(promptRow?.avgPromptChars).toBeCloseTo(15);
    expect(promptRow?.totalTokens).toBe(10);
    expect(promptRow?.invalidSteps).toBe(1);
    expect(rows[1]?.runtime).toBe('state3');
    expect(rows[1]?.runs).toBe(1);
    expect(rows[1]?.avgAccuracy).toBeCloseTo(0.9);
  });

  it('returns no rows for no cells', () => {
    expect(summarizeMatrix([])).toEqual([]);
  });
});
