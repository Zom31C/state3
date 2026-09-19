import { describe, expect, it } from 'vitest';
import type { StateDict } from '../../src/core/types.js';
import { validatePatch } from '../../src/core/validator.js';
import {
  DEV_TASK_INSTRUCTIONS,
  devTaskGuard,
  devTaskInitialState,
  devTaskSchema,
  devTaskSkill,
} from '../../src/tasks/schema.js';

/** Build a valid state as a plain StateDict (avoids interface→index-signature friction). */
function makeState(overrides: StateDict = {}): StateDict {
  const base: StateDict = {
    goal: 'Test goal',
    status: 'active',
    plan: [],
    artifacts: {},
    verifications: [],
    decisions: [],
    blockers: [],
    next: { action: 'Do something', risk: 'safe' },
  };
  return { ...base, ...overrides };
}

describe('devTaskSchema', () => {
  it('accepts a valid full state', () => {
    const state = makeState({
      plan: [{ id: '1', task: 'Implement feature', status: 'in_progress', notes: '' }],
      artifacts: { 'src/main.ts': 'entry point' },
      verifications: [{ check: 'npm test', status: 'pass' }],
      decisions: ['Chose approach A over B'],
    });
    expect(devTaskSchema.safeParse(state).success).toBe(true);
  });

  it('rejects an unknown top-level key', () => {
    expect(devTaskSchema.safeParse(makeState({ extra: 'nope' })).success).toBe(false);
  });

  it('rejects an unknown key inside PlanItem', () => {
    const state = makeState({
      plan: [{ id: '1', task: 'x', status: 'pending', notes: '', bogus: true }],
    });
    expect(devTaskSchema.safeParse(state).success).toBe(false);
  });

  it('accepts an archived plan step, but only as a boolean flag', () => {
    const archived = makeState({
      plan: [{ id: '1', task: 'x', status: 'done', notes: '', archived: true }],
    });
    expect(devTaskSchema.safeParse(archived).success).toBe(true);

    const notAFlag = makeState({
      plan: [{ id: '1', task: 'x', status: 'done', notes: '', archived: 'yes' }],
    });
    expect(devTaskSchema.safeParse(notAFlag).success).toBe(false);
  });

  it('reads a state written before archived existed, which is every state so far', () => {
    const state = makeState({ plan: [{ id: '1', task: 'x', status: 'done', notes: '' }] });
    expect(devTaskSchema.safeParse(state).success).toBe(true);
  });

  it('tells the agent to archive, since a field nobody sets saves nothing', () => {
    expect(DEV_TASK_INSTRUCTIONS).toContain('archived');
    expect(DEV_TASK_INSTRUCTIONS).toContain('{"plan[3].status":"done","plan[3].archived":true}');
  });

  it('rejects a wrong type (status: 1)', () => {
    expect(devTaskSchema.safeParse(makeState({ status: 1 })).success).toBe(false);
  });

  it("rejects an invalid enum value (risk: 'risky')", () => {
    const state = makeState({ next: { action: 'x', risk: 'risky' } });
    expect(devTaskSchema.safeParse(state).success).toBe(false);
  });

  it('rejects an empty goal', () => {
    expect(devTaskSchema.safeParse(makeState({ goal: '' })).success).toBe(false);
  });

  it('devTaskInitialState passes the schema', () => {
    expect(devTaskSchema.safeParse(devTaskInitialState('Build a thing')).success).toBe(true);
  });
});

describe('devTaskGuard', () => {
  it('returns null for an acceptable patch', () => {
    expect(devTaskGuard(makeState(), { status: 'active' })).toBeNull();
    expect(devTaskGuard(makeState(), { decisions: ['something'] })).toBeNull();
  });

  it('rejects reopening a done task', () => {
    const state = makeState({ status: 'done' });
    expect(devTaskGuard(state, { status: 'active' })).toBe(
      'task is done; start a new task instead of reopening this one',
    );
  });

  it('allows keeping a done task done (same status)', () => {
    const state = makeState({ status: 'done' });
    expect(devTaskGuard(state, { status: 'done' })).toBeNull();
  });

  it('allows reopening a done plan item with non-empty notes', () => {
    const state = makeState({
      plan: [{ id: '1', task: 'x', status: 'done', notes: 'completed earlier' }],
    });
    const patch: StateDict = {
      plan: [{ id: '1', task: 'x', status: 'in_progress', notes: 'reopening: spec changed' }],
    };
    expect(devTaskGuard(state, patch)).toBeNull();
  });

  it('rejects reopening a done plan item with empty notes', () => {
    const state = makeState({
      plan: [{ id: '1', task: 'x', status: 'done', notes: '' }],
    });
    const patch: StateDict = {
      plan: [{ id: '1', task: 'x', status: 'in_progress', notes: '' }],
    };
    expect(devTaskGuard(state, patch)).toBe(
      'plan item 1 is done; add an explanation in notes to reopen it',
    );
  });

  it('allows a new plan item (no id match) regardless of notes', () => {
    const state = makeState({
      plan: [{ id: '1', task: 'x', status: 'done', notes: '' }],
    });
    const patch: StateDict = {
      plan: [
        { id: '1', task: 'x', status: 'done', notes: '' },
        { id: '2', task: 'y', status: 'pending', notes: '' },
      ],
    };
    expect(devTaskGuard(state, patch)).toBeNull();
  });

  it('rejects blocked status with explicitly empty blockers', () => {
    expect(devTaskGuard(makeState(), { status: 'blocked', blockers: [] })).toBe(
      'status blocked requires at least one entry in blockers',
    );
  });

  it('allows blocked status when blockers is not provided in the patch', () => {
    expect(devTaskGuard(makeState(), { status: 'blocked' })).toBeNull();
  });

  it('does not throw on garbage patches', () => {
    const state = makeState();
    expect(devTaskGuard(state, { plan: 'x' })).toBeNull();
    expect(devTaskGuard(state, { plan: [null] })).toBeNull();
    expect(devTaskGuard(state, { plan: [42, 'str'] })).toBeNull();

    const noPlan = makeState();
    delete noPlan.plan;
    expect(devTaskGuard(noPlan, { plan: [{ id: '1' }] })).toBeNull();
  });
});

describe('devTaskSkill', () => {
  it("returns a Skill named 'dev-task' with guard and schema accepting initialState", () => {
    const skill = devTaskSkill();
    expect(skill.name).toBe('dev-task');
    expect(skill.guard).toBeDefined();
    expect(typeof skill.guard).toBe('function');
    expect(skill.schema.safeParse(skill.initialState).success).toBe(true);
    expect(skill.instructions).toBe(DEV_TASK_INSTRUCTIONS);
  });
});

describe('validatePatch with devTaskSkill', () => {
  it('reports unknown-key for an unrecognized top-level key', () => {
    const skill = devTaskSkill();
    const result = validatePatch(skill, skill.initialState, { bogus: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.category).toBe('unknown-key');
  });

  it('reports guard for a guard violation', () => {
    const skill = devTaskSkill();
    const doneState: StateDict = { ...skill.initialState, status: 'done' };
    const result = validatePatch(skill, doneState, { status: 'active' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.category).toBe('guard');
  });

  it('accepts a valid patch', () => {
    const skill = devTaskSkill();
    expect(validatePatch(skill, skill.initialState, { decisions: ['chose X'] })).toEqual({
      ok: true,
    });
  });
});
