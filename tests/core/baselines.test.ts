import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { BaselineKind } from '../../src/core/baselines.js';
import {
  BaselineRuntime,
  buildSummaryPrompt,
  INVALID_ACTION_PLACEHOLDER,
} from '../../src/core/baselines.js';
import type { Skill } from '../../src/core/skill.js';
import { mergeState } from '../../src/core/state.js';
import type { Environment } from '../../src/envs/env.js';
import type { LLMProvider, LLMResponse } from '../../src/llm/provider.js';

class ToyEnv implements Environment {
  readonly actions: string[] = [];
  private index = 0;

  constructor(private readonly observations: string[]) {}

  observe(): string {
    return this.observations[Math.min(this.index, this.observations.length - 1)] ?? '';
  }

  step(action: string): void {
    this.actions.push(action);
    this.index += 1;
  }
}

function makeSkill(): Skill {
  return {
    name: 'toy',
    instructions: 'a toy robot.',
    schema: z.strictObject({ a: z.string().nullable() }),
    initialState: { a: null },
  };
}

const USAGE = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

class BranchingProvider implements LLMProvider {
  readonly kind = 'branching';
  readonly model = 'mock';
  readonly prompts: string[] = [];
  private mainCursor = 0;
  private summaryCursor = 0;

  constructor(
    private readonly mainResponses: string[],
    private readonly summaryResponses: string[] = [],
  ) {}

  async complete(prompt: string): Promise<LLMResponse> {
    this.prompts.push(prompt);
    const isSummary = prompt.includes('Write the updated summary');
    const text = isSummary ? this.nextSummary() : this.nextMain();
    return { text, model: this.model, usage: { ...USAGE } };
  }

  private nextMain(): string {
    if (this.mainResponses.length === 0) return 'no markers here';
    const text = this.mainResponses[this.mainCursor % this.mainResponses.length] ?? '';
    this.mainCursor += 1;
    return text;
  }

  private nextSummary(): string {
    if (this.summaryResponses.length === 0) return 'summary';
    const text = this.summaryResponses[this.summaryCursor % this.summaryResponses.length] ?? '';
    this.summaryCursor += 1;
    return text;
  }
}

function actionResponse(action: string, reasoning = 'r'): string {
  return `Reasoning: ${reasoning}\nAction: ${action}`;
}

function makeRuntime(
  kind: BaselineKind,
  provider: LLMProvider,
  env: Environment,
  extra: { maxRetries?: number; memoryWindow?: number; summarizeEvery?: number } = {},
): BaselineRuntime {
  return new BaselineRuntime({
    skill: makeSkill(),
    env,
    provider,
    kind,
    actionStateUpdater: (state, action) => {
      const [verb, value] = action.split(' ');
      if (verb === 'SET' && value !== undefined) return mergeState(state, { a: value });
      return state;
    },
    ...extra,
  });
}

describe('BaselineRuntime kind=prompt (A.1, append-only)', () => {
  it('accumulates the full transcript and grows the prompt every step', async () => {
    const provider = new BranchingProvider([
      actionResponse('A0', 'r0'),
      actionResponse('A1', 'r1'),
    ]);
    const env = new ToyEnv(['obs0', 'obs1']);

    const result = await makeRuntime('prompt', provider, env).run(2);

    expect(result.validSteps).toBe(2);
    expect(result.llmCalls).toBe(2);
    expect(env.actions).toEqual(['A0', 'A1']);
    expect(provider.prompts[0]).toContain('You are a toy robot.');
    expect(provider.prompts[0]).toContain('Observation: obs0\nReasoning:');
    expect(provider.prompts[1]).toContain('Action: A0');
    expect(provider.prompts[1]).toContain('Observation: obs0');
    expect(provider.prompts[1]).toContain('Observation: obs1');
    const len0 = (provider.prompts[0] ?? '').length;
    const len1 = (provider.prompts[1] ?? '').length;
    expect(len1).toBeGreaterThan(len0);
    expect(result.finalState).toEqual({});
  });
});

describe('BaselineRuntime kind=stateful (A.3, state + full transcript)', () => {
  it('keeps the state block updated via the action updater', async () => {
    const provider = new BranchingProvider([actionResponse('SET x'), actionResponse('NOOP')]);
    const env = new ToyEnv(['obs0', 'obs1']);

    const result = await makeRuntime('stateful', provider, env).run(2);

    expect(result.validSteps).toBe(2);
    expect(provider.prompts[0]).toContain('Current skill state:');
    expect(provider.prompts[0]).toContain('{"a":null}');
    expect(provider.prompts[1]).toContain('{"a":"x"}');
    expect(provider.prompts[1]).toContain('Action: SET x');
    expect(result.finalState).toEqual({ a: 'x' });
  });

  it('requires an actionStateUpdater', () => {
    expect(
      () =>
        new BaselineRuntime({
          skill: makeSkill(),
          env: new ToyEnv(['x']),
          provider: new BranchingProvider([]),
          kind: 'stateful',
        }),
    ).toThrow(/requires actionStateUpdater/);
  });
});

describe('BaselineRuntime kind=memory (A.2, summary + window)', () => {
  it('folds departing entries into the summary with periodic LLM calls', async () => {
    const provider = new BranchingProvider(
      [actionResponse('A0'), actionResponse('A1'), actionResponse('A2')],
      ['S1', 'S2'],
    );
    const env = new ToyEnv(['obs0', 'obs1', 'obs2']);

    const result = await makeRuntime('memory', provider, env, {
      memoryWindow: 1,
      summarizeEvery: 1,
    }).run(3);

    expect(result.validSteps).toBe(3);
    expect(env.actions).toEqual(['A0', 'A1', 'A2']);
    // [step0 main, step1 main, summary1, step2 main, summary2]
    expect(result.llmCalls).toBe(5);
    expect(result.tokens.total).toBe(75);

    expect(provider.prompts[1]).toContain('Nothing summarized yet.');
    expect(provider.prompts[1]).toContain('Action: A0');

    const summaryPrompt = provider.prompts[2] ?? '';
    expect(summaryPrompt).toContain('Write the updated summary');
    expect(summaryPrompt).toContain('Action: A0');
    expect(summaryPrompt).not.toContain('Action: A1');

    const step2Prompt = provider.prompts[3] ?? '';
    expect(step2Prompt).toContain('Past summary:\nS1');
    expect(step2Prompt).toContain('Action: A1');
    expect(step2Prompt).not.toContain('Action: A0');

    expect(provider.prompts[4]).toContain('Previous summary:\nS1');
  });

  it('renders the summary prompt with instructions and transcript', () => {
    const prompt = buildSummaryPrompt(makeSkill(), 'old summary', [
      { observation: 'o', reasoning: 'r', action: 'a' },
    ]);
    expect(prompt).toContain('a toy robot.');
    expect(prompt).toContain('Previous summary:\nold summary');
    expect(prompt).toContain('Observation: o\nReasoning: r\nAction: a');
    expect(prompt).toContain('Respond with the summary text only.');
  });
});

describe('BaselineRuntime retries', () => {
  it('retries an unparseable response and records the parse error', async () => {
    const provider = new BranchingProvider(['prose without markers', actionResponse('A0')]);
    const env = new ToyEnv(['obs0']);

    const result = await makeRuntime('prompt', provider, env).run(1);

    const record = result.steps[0];
    expect(record?.valid).toBe(true);
    expect(record?.retries).toBe(1);
    expect(record?.errors[0]?.category).toBe('missing-action');
    expect(provider.prompts[1]).toContain('Your previous response was invalid');
  });

  it('marks the step invalid after exhausting retries and appends a placeholder entry', async () => {
    const provider = new BranchingProvider(['garbage']);
    const env = new ToyEnv(['obs0', 'obs1']);

    const result = await makeRuntime('prompt', provider, env, { maxRetries: 1 }).run(2);

    expect(result.invalidSteps).toBe(2);
    expect(result.validSteps).toBe(0);
    expect(result.llmCalls).toBe(4);
    expect(env.actions).toEqual([]);
    expect(result.steps[0]?.errors).toHaveLength(2);
    expect(result.errorCounts).toEqual({ 'missing-action': 4 });
    expect(provider.prompts[2]).toContain(INVALID_ACTION_PLACEHOLDER);
  });

  it('rejects an invalid memory window', () => {
    expect(
      () =>
        new BaselineRuntime({
          skill: makeSkill(),
          env: new ToyEnv(['x']),
          provider: new BranchingProvider([]),
          kind: 'memory',
          memoryWindow: 0,
        }),
    ).toThrow(/>= 1/);
  });
});
