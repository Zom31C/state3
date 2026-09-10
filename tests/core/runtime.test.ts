import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SkillStateRuntime, STEP_JSON_SCHEMA } from '../../src/core/runtime.js';
import type { Skill } from '../../src/core/skill.js';
import type { Environment } from '../../src/envs/env.js';
import type { CompletionOptions, LLMProvider, LLMResponse } from '../../src/llm/provider.js';

class ScriptedProvider implements LLMProvider {
  readonly kind = 'scripted';
  readonly model = 'mock';
  readonly prompts: string[] = [];
  readonly optionsSeen: CompletionOptions[] = [];
  private cursor = 0;

  constructor(private readonly responses: string[]) {}

  async complete(prompt: string, options: CompletionOptions = {}): Promise<LLMResponse> {
    this.prompts.push(prompt);
    this.optionsSeen.push(options);
    const text = this.responses[Math.min(this.cursor, this.responses.length - 1)] ?? '';
    this.cursor += 1;
    return {
      text,
      model: this.model,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };
  }
}

class RecordingEnv implements Environment {
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

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: 'test-skill',
    instructions: 'a test robot.',
    schema: z.strictObject({
      shelf_0: z.string().nullable(),
      shelf_1: z.string().nullable(),
    }),
    initialState: { shelf_0: null, shelf_1: null },
    ...overrides,
  };
}

function stepResponse(patch: Record<string, unknown>, action: string): string {
  return [
    'The shelf is free, so the item should be stored there.',
    '```json',
    JSON.stringify({ state_patch: patch, action }),
    '```',
  ].join('\n');
}

describe('SkillStateRuntime', () => {
  it('runs a happy-path episode and applies patches and actions', async () => {
    const skill = makeSkill();
    const provider = new ScriptedProvider([
      stepResponse({ shelf_0: 'widget' }, 'STORE widget shelf_0'),
      stepResponse({ shelf_1: 'gadget' }, 'STORE gadget shelf_1'),
    ]);
    const env = new RecordingEnv([
      'Shipment arrived containing [widget]',
      'Shipment arrived containing [gadget]',
    ]);

    const result = await new SkillStateRuntime({ skill, env, provider }).run(2);

    expect(result.validSteps).toBe(2);
    expect(result.invalidSteps).toBe(0);
    expect(result.totalRetries).toBe(0);
    expect(result.llmCalls).toBe(2);
    expect(env.actions).toEqual(['STORE widget shelf_0', 'STORE gadget shelf_1']);
    expect(result.finalState).toEqual({ shelf_0: 'widget', shelf_1: 'gadget' });
    expect(result.tokens).toEqual({ prompt: 20, completion: 10, total: 30 });
    expect(result.promptChars).toBeGreaterThan(0);
    expect(result.steps.map((s) => s.valid)).toEqual([true, true]);
  });

  it('builds the O(1) SKILL.state prompt with instructions, state, and observation', async () => {
    const provider = new ScriptedProvider([
      stepResponse({ shelf_0: 'widget' }, 'STORE widget shelf_0'),
    ]);
    const env = new RecordingEnv(['Shipment arrived containing [widget]']);

    await new SkillStateRuntime({ skill: makeSkill(), env, provider }).run(1);

    const prompt = provider.prompts[0] ?? '';
    expect(prompt).toContain('You are a test robot.');
    expect(prompt).toContain('Skill Execution State:');
    expect(prompt).toContain('{"shelf_0":null,"shelf_1":null}');
    expect(prompt).toContain('Latest Observation:');
    expect(prompt).toContain('Shipment arrived containing [widget]');
    expect(prompt).toContain('"state_patch"');
  });

  it('retries after a malformed response and records the parse error', async () => {
    const provider = new ScriptedProvider([
      'I cannot answer in that format.',
      stepResponse({ shelf_0: 'widget' }, 'STORE widget shelf_0'),
    ]);
    const env = new RecordingEnv(['Shipment arrived containing [widget]']);

    const result = await new SkillStateRuntime({ skill: makeSkill(), env, provider }).run(1);

    const record = result.steps[0];
    expect(result.validSteps).toBe(1);
    expect(record?.valid).toBe(true);
    expect(record?.retries).toBe(1);
    expect(record?.errors).toHaveLength(1);
    expect(record?.errors[0]?.category).toMatch(/no-json-found|json-syntax/);
    expect(provider.prompts).toHaveLength(2);
    expect(provider.prompts[1]).toContain('Your previous response was invalid');
  });

  it('retries after a schema-invalid patch and keeps the state intact meanwhile', async () => {
    const provider = new ScriptedProvider([
      stepResponse({ shelf_0: 123 }, 'STORE 123 shelf_0'),
      stepResponse({ shelf_0: 'widget' }, 'STORE widget shelf_0'),
    ]);
    const env = new RecordingEnv(['Shipment arrived containing [widget]']);

    const result = await new SkillStateRuntime({ skill: makeSkill(), env, provider }).run(1);

    const record = result.steps[0];
    expect(record?.valid).toBe(true);
    expect(record?.retries).toBe(1);
    expect(record?.errors[0]?.category).toBe('type-coercion');
    expect(env.actions).toEqual(['STORE widget shelf_0']);
    expect(result.finalState).toEqual({ shelf_0: 'widget', shelf_1: null });
  });

  it('rejects unknown keys via the strict schema', async () => {
    const provider = new ScriptedProvider([
      stepResponse({ shelf_9: 'x' }, 'STORE x shelf_9'),
      stepResponse({ shelf_0: 'widget' }, 'STORE widget shelf_0'),
    ]);
    const env = new RecordingEnv(['Shipment arrived containing [widget]']);

    const result = await new SkillStateRuntime({ skill: makeSkill(), env, provider }).run(1);

    expect(result.steps[0]?.errors[0]?.category).toBe('unknown-key');
    expect(result.steps[0]?.valid).toBe(true);
  });

  it('marks the step invalid after exhausting retries without touching state or env', async () => {
    const provider = new ScriptedProvider(['nonsense without json']);
    const env = new RecordingEnv(['Shipment arrived containing [widget]']);

    const result = await new SkillStateRuntime({
      skill: makeSkill(),
      env,
      provider,
      maxRetries: 2,
    }).run(1);

    const record = result.steps[0];
    expect(result.invalidSteps).toBe(1);
    expect(result.validSteps).toBe(0);
    expect(record?.valid).toBe(false);
    expect(record?.retries).toBe(2);
    expect(record?.errors).toHaveLength(3);
    expect(record?.action).toBeUndefined();
    expect(env.actions).toEqual([]);
    expect(result.finalState).toEqual({ shelf_0: null, shelf_1: null });
    expect(result.llmCalls).toBe(3);
    const notices = provider.prompts[2]?.match(/Your previous response was invalid/g) ?? [];
    expect(notices).toHaveLength(2);
    expect(result.errorCounts).toEqual({ 'no-json-found': 3 });
  });

  it('runs the domain guard before applying patches', async () => {
    const skill = makeSkill({
      initialState: { shelf_0: null, shelf_1: 'widget' },
      guard: (state, patch) =>
        patch.shelf_1 !== undefined && patch.shelf_1 !== null && state.shelf_1 !== null
          ? 'shelf_1 already holds an item'
          : null,
    });
    const provider = new ScriptedProvider([
      stepResponse({ shelf_1: 'other' }, 'STORE other shelf_1'),
      stepResponse({ shelf_0: 'gadget' }, 'STORE gadget shelf_0'),
    ]);
    const env = new RecordingEnv(['Customer ordered [x]']);

    const result = await new SkillStateRuntime({ skill, env, provider }).run(1);

    expect(result.steps[0]?.errors[0]?.category).toBe('guard');
    expect(result.steps[0]?.valid).toBe(true);
    expect(result.finalState).toEqual({ shelf_0: 'gadget', shelf_1: 'widget' });
  });

  it('deletes a key when the patch sets it to null', async () => {
    const skill = makeSkill({
      schema: z.record(z.string(), z.string().nullable()),
      initialState: { shelf_0: null, pending: 'order-7' },
    });
    const provider = new ScriptedProvider([
      stepResponse({ pending: null }, 'SHIP order-7 shelf_0'),
    ]);
    const env = new RecordingEnv(['Customer ordered [widget]']);

    const result = await new SkillStateRuntime({ skill, env, provider }).run(1);

    expect(result.steps[0]?.valid).toBe(true);
    expect(result.finalState).toEqual({ shelf_0: null });
    expect('pending' in result.finalState).toBe(false);
  });

  it('stops early when the environment reports done', async () => {
    const env: Environment = { observe: () => 'x', step: () => undefined, done: true };
    const provider = new ScriptedProvider([stepResponse({}, 'NOOP')]);

    const result = await new SkillStateRuntime({ skill: makeSkill(), env, provider }).run(5);

    expect(result.steps).toEqual([]);
    expect(result.llmCalls).toBe(0);
  });

  it('rejects a negative or fractional horizon', async () => {
    const env = new RecordingEnv(['x']);
    const provider = new ScriptedProvider(['y']);
    const runtime = new SkillStateRuntime({ skill: makeSkill(), env, provider });

    await expect(runtime.run(-1)).rejects.toThrow(/non-negative integer/);
    await expect(runtime.run(1.5)).rejects.toThrow(/non-negative integer/);
  });

  it('passes the step JSON schema when structuredOutput is enabled', async () => {
    const provider = new ScriptedProvider([
      stepResponse({ shelf_0: 'widget' }, 'STORE widget shelf_0'),
    ]);
    const env = new RecordingEnv(['Shipment arrived containing [widget]']);

    await new SkillStateRuntime({
      skill: makeSkill(),
      env,
      provider,
      structuredOutput: true,
    }).run(1);

    expect(provider.optionsSeen[0]).toEqual({ jsonSchema: STEP_JSON_SCHEMA });
  });

  it('passes empty completion options when structuredOutput is off', async () => {
    const provider = new ScriptedProvider([
      stepResponse({ shelf_0: 'widget' }, 'STORE widget shelf_0'),
    ]);
    const env = new RecordingEnv(['Shipment arrived containing [widget]']);

    await new SkillStateRuntime({ skill: makeSkill(), env, provider }).run(1);

    expect(provider.optionsSeen[0]).toEqual({});
  });
});
