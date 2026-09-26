import { describe, expect, it } from 'vitest';
import type { StateDict } from '../../src/core/types.js';
import { validatePatch } from '../../src/core/validator.js';
import {
  ROUND_VERDICTS,
  SUPERVISE_TASK_INSTRUCTIONS,
  superviseTaskGuard,
  superviseTaskInitialState,
  superviseTaskProgress,
  superviseTaskSchema,
  superviseTaskSkill,
} from '../../src/tasks/supervise.js';
import type { Round, SuperviseTaskState } from '../../src/tasks/supervise.js';

/**
 * An unannotated return type on purpose: `Round` is an interface, so it has no
 * implicit index signature and would not fit into a StateDict.
 */
function makeRound(overrides: Partial<Round> = {}) {
  const verdict: Round['verdict'] = 'pending';
  return {
    id: '1',
    assignment: 'implement the parser',
    verdict,
    evidence: '',
    feedback: '',
    ...overrides,
  };
}

/** A valid Σ as a plain StateDict, so guard calls need no casting at every site. */
function makeState(overrides: StateDict = {}): StateDict {
  const base: StateDict = {
    goal: 'Review the worker',
    status: 'active',
    spec: 'SPEC.md rev 3',
    worker: 'qwen3 on LM Studio, state at .state3',
    rounds: [],
    decisions: [],
    blockers: [],
    next: { action: 'Write the first assignment', risk: 'safe' },
  };
  return { ...base, ...overrides };
}

const ACCEPTED_EVIDENCE = 'read src/parser.ts; npx vitest run tests/core passed (42 tests)';

describe('superviseTaskSchema', () => {
  it('accepts a well-formed Σ with rounds of every verdict', () => {
    const state = makeState({
      rounds: [
        makeRound({ verdict: 'accepted', evidence: ACCEPTED_EVIDENCE }),
        makeRound({ id: '2', verdict: 'rejected', feedback: 'spec 3.1 asks for a stream' }),
        makeRound({ id: '3' }),
      ],
      decisions: ['scope cut: no caching'],
    });
    expect(superviseTaskSchema.safeParse(state).success).toBe(true);
  });

  it('accepts the initial state of a new supervision', () => {
    expect(
      superviseTaskSchema.safeParse(superviseTaskInitialState('Review the worker')).success,
    ).toBe(true);
  });

  it('rejects an unknown top-level key', () => {
    expect(superviseTaskSchema.safeParse(makeState({ plan: [] })).success).toBe(false);
    expect(superviseTaskSchema.safeParse(makeState({ artifacts: {} })).success).toBe(false);
  });

  it('rejects an unknown key inside a round', () => {
    const state = makeState({ rounds: [{ ...makeRound(), notes: 'extra' }] });
    expect(superviseTaskSchema.safeParse(state).success).toBe(false);
  });

  it('rejects a verdict outside the enum', () => {
    const state = makeState({ rounds: [{ ...makeRound(), verdict: 'maybe' }] });
    expect(superviseTaskSchema.safeParse(state).success).toBe(false);
  });

  it('rejects a missing field, an empty goal and an empty assignment', () => {
    const missing = makeState();
    delete missing['worker'];
    expect(superviseTaskSchema.safeParse(missing).success).toBe(false);
    expect(superviseTaskSchema.safeParse(makeState({ goal: '' })).success).toBe(false);
    expect(
      superviseTaskSchema.safeParse(makeState({ rounds: [makeRound({ assignment: '' })] })).success,
    ).toBe(false);
  });

  it('rejects a wrong type and a bad risk level', () => {
    expect(superviseTaskSchema.safeParse(makeState({ rounds: 'none' })).success).toBe(false);
    expect(
      superviseTaskSchema.safeParse(makeState({ next: { action: 'x', risk: 'risky' } })).success,
    ).toBe(false);
  });

  it('accepts an empty evidence and feedback string, which the guard polices instead', () => {
    expect(superviseTaskSchema.safeParse(makeState({ rounds: [makeRound()] })).success).toBe(true);
  });
});

describe('ROUND_VERDICTS', () => {
  it('are pending, accepted and rejected', () => {
    expect(ROUND_VERDICTS).toEqual(['pending', 'accepted', 'rejected']);
  });
});

describe('superviseTaskGuard', () => {
  it('returns null for an acceptable patch', () => {
    expect(superviseTaskGuard(makeState(), { status: 'active' })).toBeNull();
    expect(superviseTaskGuard(makeState(), { decisions: ['scope cut'] })).toBeNull();
    expect(superviseTaskGuard(makeState(), { spec: 'SPEC.md rev 4' })).toBeNull();
    expect(superviseTaskGuard(makeState(), { rounds: [makeRound()] })).toBeNull();
  });

  it('rejects reopening a done task', () => {
    const state = makeState({ status: 'done' });
    expect(superviseTaskGuard(state, { status: 'active' })).toBe(
      'task is done; start a new task instead of reopening this one',
    );
    expect(superviseTaskGuard(state, { status: 'blocked' })).toBe(
      'task is done; start a new task instead of reopening this one',
    );
  });

  it('allows keeping a done task done', () => {
    expect(superviseTaskGuard(makeState({ status: 'done' }), { status: 'done' })).toBeNull();
  });

  it('rejects blocked status with explicitly empty blockers', () => {
    expect(superviseTaskGuard(makeState(), { status: 'blocked', blockers: [] })).toBe(
      'status blocked requires at least one entry in blockers',
    );
  });

  it('allows blocked status when the patch names a blocker, or none at all', () => {
    expect(
      superviseTaskGuard(makeState(), { status: 'blocked', blockers: ['worker offline'] }),
    ).toBeNull();
    expect(
      superviseTaskGuard(makeState({ blockers: ['worker offline'] }), { status: 'blocked' }),
    ).toBeNull();
  });

  it('rejects an accepted round without evidence', () => {
    const state = makeState({ rounds: [makeRound()] });
    expect(superviseTaskGuard(state, { rounds: [makeRound({ verdict: 'accepted' })] })).toBe(
      `round 1 cannot be accepted without evidence: record what you checked yourself ` +
        '(files read, commands run, output seen)',
    );
  });

  it('rejects an accepted round whose evidence is only whitespace', () => {
    const patch = { rounds: [makeRound({ verdict: 'accepted', evidence: '   ' })] };
    expect(superviseTaskGuard(makeState(), patch)).toContain('cannot be accepted without evidence');
  });

  it('accepts a round backed by evidence', () => {
    const patch = { rounds: [makeRound({ verdict: 'accepted', evidence: ACCEPTED_EVIDENCE })] };
    expect(superviseTaskGuard(makeState(), patch)).toBeNull();
  });

  it('rejects a rejected round without feedback', () => {
    const patch = { rounds: [makeRound({ id: '2', verdict: 'rejected' })] };
    expect(superviseTaskGuard(makeState(), patch)).toBe(
      'round 2 cannot be rejected without feedback: say what the worker must change',
    );
  });

  it('rejects a rejected round whose feedback is only whitespace', () => {
    const patch = { rounds: [makeRound({ verdict: 'rejected', feedback: '  ' })] };
    expect(superviseTaskGuard(makeState(), patch)).toContain('cannot be rejected without feedback');
  });

  it('accepts a rejection that says what to change', () => {
    const patch = {
      rounds: [makeRound({ verdict: 'rejected', feedback: 'spec 3.1 asks for a stream' })],
    };
    expect(superviseTaskGuard(makeState(), patch)).toBeNull();
  });

  it('allows one pending round, but not two', () => {
    expect(
      superviseTaskGuard(makeState(), {
        rounds: [
          makeRound({ verdict: 'accepted', evidence: ACCEPTED_EVIDENCE }),
          makeRound({ id: '2' }),
        ],
      }),
    ).toBeNull();

    expect(superviseTaskGuard(makeState(), { rounds: [makeRound(), makeRound({ id: '2' })] })).toBe(
      'one round at a time: review the pending round before assigning the next one',
    );
  });

  it('names the round by id, or "?" when the id is unusable', () => {
    expect(
      superviseTaskGuard(makeState(), { rounds: [makeRound({ id: 'r7', verdict: 'accepted' })] }),
    ).toBe(
      'round r7 cannot be accepted without evidence: record what you checked yourself ' +
        '(files read, commands run, output seen)',
    );
    const noId: StateDict = { assignment: 'x', verdict: 'accepted', evidence: '', feedback: '' };
    expect(superviseTaskGuard(makeState(), { rounds: [noId] })).toContain(
      'round ? cannot be accepted',
    );
  });

  it('reports the first violated round, in order', () => {
    const patch = {
      rounds: [
        makeRound({ verdict: 'rejected', feedback: 'fix the stream' }),
        makeRound({ id: '2', verdict: 'accepted' }),
      ],
    };
    expect(superviseTaskGuard(makeState(), patch)).toContain('round 2 cannot be accepted');
  });

  it('does not throw on garbage patches', () => {
    const state = makeState();
    expect(superviseTaskGuard(state, { rounds: 'x' })).toBeNull();
    expect(superviseTaskGuard(state, { rounds: [null] })).toBeNull();
    expect(superviseTaskGuard(state, { rounds: [42, 'str'] })).toBeNull();
    expect(superviseTaskGuard(state, {})).toBeNull();

    const stateless: StateDict = { goal: 'x' };
    expect(superviseTaskGuard(stateless, { rounds: [makeRound()] })).toBeNull();
  });
});

describe('superviseTaskProgress', () => {
  it('counts accepted rounds over all of them', () => {
    const state = makeState({
      rounds: [
        makeRound({ verdict: 'accepted', evidence: ACCEPTED_EVIDENCE }),
        makeRound({ id: '2', verdict: 'rejected', feedback: 'fix it' }),
        makeRound({ id: '3', verdict: 'accepted', evidence: 'ran the checks' }),
        makeRound({ id: '4' }),
      ],
    });
    expect(superviseTaskProgress(state)).toEqual({ done: 2, total: 4 });
  });

  it('is 0/0 for a fresh supervision', () => {
    expect(superviseTaskProgress(makeState())).toEqual({ done: 0, total: 0 });
    expect(
      superviseTaskProgress(superviseTaskInitialState('Review the worker') as unknown as StateDict),
    ).toEqual({ done: 0, total: 0 });
  });

  it('is 0/0 when rounds is missing or not an array', () => {
    const noRounds: StateDict = { goal: 'x' };
    expect(superviseTaskProgress(noRounds)).toEqual({ done: 0, total: 0 });
    expect(superviseTaskProgress(makeState({ rounds: 'none' }))).toEqual({ done: 0, total: 0 });
  });

  it('ignores entries that are not rounds when counting, but still counts them as total', () => {
    const state = makeState({
      rounds: [
        null,
        42,
        { verdict: 'accepted' },
        makeRound({ verdict: 'accepted', evidence: 'x' }),
      ],
    });
    expect(superviseTaskProgress(state)).toEqual({ done: 2, total: 4 });
  });
});

describe('superviseTaskSkill', () => {
  it("returns a Skill named 'supervise-task' wired to this module", () => {
    const skill = superviseTaskSkill();
    expect(skill.name).toBe('supervise-task');
    expect(skill.instructions).toBe(SUPERVISE_TASK_INSTRUCTIONS);
    expect(skill.guard).toBe(superviseTaskGuard);
    expect(skill.progress).toBe(superviseTaskProgress);
    expect(skill.schema.safeParse(skill.initialState).success).toBe(true);
    expect(skill.initialState).toEqual(superviseTaskInitialState('placeholder'));
  });

  it('has no newPlanItem, so a supervision takes no plan', () => {
    expect(superviseTaskSkill().newPlanItem).toBeUndefined();
  });

  it('writes a procedure about supervising, with the shared blocks composed in', () => {
    const text = SUPERVISE_TASK_INSTRUCTIONS;
    expect(text).toContain('You are supervising a long task');
    expect(text).toContain('rounds: array of { id, assignment, verdict, evidence, feedback }');
    expect(text).toContain('Never accept on the worker');
    expect(text).toContain('only one round may be pending at a time');
    // Shared procedure blocks, composed rather than duplicated.
    expect(text).toContain('Risk levels for next.risk');
    expect(text).toContain('Patch semantics');
    expect(text).toContain('State hygiene');
  });

  it('drives validatePatch: the guard fires before the schema', () => {
    const skill = superviseTaskSkill();
    const state = makeState({ rounds: [makeRound()] });

    const guarded = validatePatch(skill, state, { rounds: [makeRound({ verdict: 'accepted' })] });
    expect(guarded.ok).toBe(false);
    if (!guarded.ok) {
      expect(guarded.category).toBe('guard');
      expect(guarded.message).toContain('cannot be accepted without evidence');
    }

    const unknown = validatePatch(skill, state, { plan: [] });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.category).toBe('unknown-key');

    expect(validatePatch(skill, state, { spec: 'SPEC.md rev 4' })).toEqual({ ok: true });
  });
});

describe('superviseTaskInitialState', () => {
  it('starts active, with no rounds, no spec and a safe next step', () => {
    const state: SuperviseTaskState = superviseTaskInitialState('Review the worker');
    expect(state).toEqual({
      goal: 'Review the worker',
      status: 'active',
      spec: '',
      worker: '',
      rounds: [],
      decisions: [],
      blockers: [],
      next: {
        action: 'Name the spec the worker follows, then write the first assignment',
        risk: 'safe',
      },
    });
  });

  it('returns a fresh object each call', () => {
    const first = superviseTaskInitialState('a');
    const second = superviseTaskInitialState('b');
    expect(first).not.toBe(second);
    expect(first.rounds).not.toBe(second.rounds);
  });
});
