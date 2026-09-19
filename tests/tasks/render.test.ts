import { describe, expect, it } from 'vitest';
import type { StateDict } from '../../src/core/types.js';
import type { Notation } from '../../src/tasks/notation.js';
import type { DevTaskState } from '../../src/tasks/schema.js';
import {
  STATE_DELTA_THRESHOLD_CHARS,
  STATE_SIZE_HINT_CHARS,
  injectedView,
  renderStateSize,
  renderTaskBrief,
  renderTaskHead,
  stateSizeHint,
  stateSizes,
} from '../../src/tasks/render.js';
import type { StoredTask } from '../../src/tasks/store.js';

function makeState(overrides: Partial<DevTaskState> = {}): DevTaskState {
  return {
    goal: 'Ship the integration',
    status: 'active',
    plan: [],
    artifacts: {},
    verifications: [],
    decisions: [],
    blockers: [],
    next: { action: 'Run the tests', risk: 'safe' },
    ...overrides,
  };
}

function makeTask(state: DevTaskState, id = 'task-9', notation: Notation = 'plain'): StoredTask {
  return {
    meta: {
      id,
      createdAt: 'c',
      updatedAt: 'u',
      path: `.skillstate/${id}.json`,
      skill: 'dev-task',
      notation,
    },
    state: state as unknown as StateDict,
  };
}

describe('renderTaskHead', () => {
  it('renders a header naming the skill, and the state as one compact JSON line', () => {
    const text = renderTaskHead(makeTask(makeState({ status: 'blocked' })));
    const lines = text.split('\n');

    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('Task task-9 [dev-task] (blocked):');
    expect(lines[1]).toBe(JSON.stringify(makeState({ status: 'blocked' })));
    expect(lines[1]).not.toMatch(/^\s/);
  });

  it('adds a compression hint once the state grows past the threshold', () => {
    const filler = 'x'.repeat(STATE_SIZE_HINT_CHARS);
    const small = makeTask(makeState({ decisions: ['short'] }));
    const large = makeTask(makeState({ decisions: [filler] }));

    expect(renderTaskHead(small).split('\n')).toHaveLength(2);

    const lines = renderTaskHead(large).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('compress it');
    expect(lines[2]).toContain(String(JSON.stringify(large.state).length));
  });

  it('reminds a compact-notation task how to write values, without P', () => {
    const lines = renderTaskHead(makeTask(makeState(), 'task-9', 'compact')).split('\n');

    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('compact notation');
    expect(lines[2]).toContain('->');
  });

  it('reads a missing or foreign status defensively', () => {
    const stateless = makeTask(makeState());
    stateless.state = { goal: 'x' };
    expect(renderTaskHead(stateless).split('\n')[0]).toBe('Task task-9 [dev-task] (unknown):');
  });
});

describe('the injected view of Σ', () => {
  const plan = [
    {
      id: '1',
      task: 'Read the feedback',
      status: 'done' as const,
      notes: 'four files',
      archived: true,
    },
    { id: '2', task: 'Build the reader', status: 'done' as const, notes: 'shipped' },
    { id: '3', task: 'Wire the hook', status: 'in_progress' as const, notes: 'half way' },
    { id: '4', task: 'Write the docs', status: 'pending' as const, notes: '' },
  ];

  it('leaves a tool answer whole: archived steps are part of Σ, not of a prompt', () => {
    const text = renderTaskHead(makeTask(makeState({ plan })));

    expect(text).toContain('Read the feedback');
    expect(text).not.toContain('archived plan step');
  });

  it('drops the archived steps from an injection, and says how many it dropped', () => {
    const lines = renderTaskHead(makeTask(makeState({ plan })), { injected: true }).split('\n');

    expect(lines[1]).not.toContain('Read the feedback');
    expect(lines[1]).toContain('Build the reader');
    expect(lines[1]).toContain('Wire the hook');
    expect(lines[1]).toContain('Write the docs');
    expect(lines.some((line) => line.startsWith('+1 archived plan step(s)'))).toBe(true);
    expect(lines.some((line) => line.includes('task_show lists every one'))).toBe(true);
  });

  it('keeps the plan array of Σ untouched, so a path key still addresses the same step', () => {
    const state = makeState({ plan });
    const view = injectedView(state as unknown as StateDict);

    expect((view.state.plan as unknown[]).map((item) => (item as { id: string }).id)).toEqual([
      '2',
      '3',
      '4',
    ]);
    // Σ itself is what task_show and the next patch read; the cut is a rendering.
    expect(state.plan).toHaveLength(4);
    expect(state.plan[0]?.id).toBe('1');
  });

  it('falls back to the step in flight once Σ outgrows the threshold', () => {
    const large = makeTask(
      makeState({
        plan,
        decisions: ['x'.repeat(STATE_DELTA_THRESHOLD_CHARS)],
        artifacts: { 'src/a.ts': 'reader' },
        verifications: [{ check: 'npm test', status: 'pass' }],
      }),
    );

    const lines = renderTaskHead(large, { injected: true }).split('\n');
    const injected = JSON.parse(lines[1] ?? '') as StateDict;

    expect(Object.keys(injected).sort()).toEqual(['blockers', 'goal', 'next', 'plan', 'status']);
    expect(injected.plan).toHaveLength(1);
    expect(lines[1]).not.toContain('xxxx');
    expect(lines[1]).not.toContain('src/a.ts');
    expect(lines[1]).not.toContain('npm test');
  });

  it('names what the delta left out and how big the state holding it is', () => {
    const large = makeTask(
      makeState({
        plan,
        decisions: ['x'.repeat(STATE_DELTA_THRESHOLD_CHARS)],
        artifacts: { 'src/a.ts': 'reader', 'src/b.ts': 'writer' },
        blockers: ['needs the user'],
      }),
    );

    const text = renderTaskHead(large, { injected: true });

    expect(text).toContain('needs the user');
    expect(text).toContain(`Σ is ${JSON.stringify(large.state).length} chars`);
    expect(text).toContain('2 artifacts');
    expect(text).toContain('1 decisions');
    expect(text).toContain('2 plan step(s) (1 done, 1 pending)');
    expect(text).toContain('plus 1 archived step(s)');
    expect(text).toContain('task_show returns all of it');
    // The delta note already complains about the size, so the plain hint does not repeat it.
    expect(text.split('\n').filter((line) => line.includes('chars —'))).toHaveLength(0);
  });

  it('keeps a state under the threshold in full even when it is over the hint size', () => {
    const medium = makeTask(makeState({ decisions: ['y'.repeat(STATE_SIZE_HINT_CHARS + 10)] }));

    const text = renderTaskHead(medium, { injected: true });

    expect(text).toContain('yyyy');
    expect(text).toContain('compress it');
  });
});

describe('the size report', () => {
  const state = makeState({
    plan: [{ id: '1', task: 'a long step description', status: 'done', notes: 'and its outcome' }],
    decisions: ['d'.repeat(200), 'another decision'],
    artifacts: { 'src/a.ts': 'the reader' },
    verifications: [{ check: 'npm test', status: 'pass' }],
  });

  it('orders the fields by what they cost, so the first line is the one to shorten', () => {
    const sizes = stateSizes(state as unknown as StateDict);

    expect(sizes[0]?.field).toBe('decisions');
    expect(sizes.map((size) => size.chars)).toEqual(
      [...sizes.map((size) => size.chars)].sort((a, b) => b - a),
    );
    expect(sizes.find((size) => size.field === 'decisions')?.entries).toBe(2);
    expect(sizes.find((size) => size.field === 'artifacts')?.entries).toBe(1);
    // A scalar field has no entries to count.
    expect(sizes.find((size) => size.field === 'goal')?.entries).toBeNull();
  });

  it('says the total, the share of each field, and how to make it smaller', () => {
    const text = renderStateSize(state as unknown as StateDict);
    const total = JSON.stringify(state).length;

    expect(text).toContain(`Σ is ${total} chars over 8 field(s)`);
    expect(text).toMatch(/decisions\s+\d+ chars \(\s*\d+%, 2 item\(s\)\)/);
    expect(text).toContain('"plan[0].archived":true');
    expect(text).toContain('task_show {"view":"state"}');
    // The report measures Σ; carrying Σ in it would cost what the call saves.
    expect(text).not.toContain('d'.repeat(200));
  });
});

describe('stateSizeHint', () => {
  it('is empty at or below the threshold and reports the size above it', () => {
    const atLimit = { decisions: ['x'.repeat(STATE_SIZE_HINT_CHARS - 20)] };
    expect(JSON.stringify(atLimit).length).toBeLessThanOrEqual(STATE_SIZE_HINT_CHARS);
    expect(stateSizeHint(atLimit)).toBe('');

    const overLimit = { decisions: ['x'.repeat(STATE_SIZE_HINT_CHARS)] };
    expect(stateSizeHint(overLimit)).toContain('Σ is ');
    expect(stateSizeHint(overLimit)).toContain('chars');
  });
});

describe('renderTaskBrief', () => {
  it('carries the goal, the step in flight and the next action — and nothing else', () => {
    const text = renderTaskBrief(
      makeTask(
        makeState({
          artifacts: { 'src/a.ts': 'new reader' },
          decisions: ['chose the hook over a tool'],
          verifications: [{ check: 'npm test', status: 'pass' }],
          plan: [
            { id: '1', task: 'Done already', status: 'done', notes: '' },
            { id: '2', task: 'Wire the hook', status: 'in_progress', notes: 'half way' },
          ],
        }),
      ),
    );

    expect(text.split('\n')).toEqual([
      'Task task-9 [dev-task] (active)',
      'goal: Ship the integration',
      'in flight: Wire the hook — half way',
      'next: Run the tests [risk: safe]',
    ]);
    // The whole point: a subagent carries these lines on every one of its turns.
    expect(text).not.toContain('chose the hook');
    expect(text).not.toContain('npm test');
    expect(text).not.toContain('src/a.ts');
  });

  it('adds the blockers, and no line for a field this skill does not have', () => {
    const blocked = renderTaskBrief(
      makeTask(makeState({ status: 'blocked', blockers: ['needs the user', 'no key'] })),
    );
    expect(blocked).toContain('(blocked)');
    expect(blocked).toContain('blocked: needs the user; no key');

    // A supervise-task state has no plan; the brief must not invent a line for it, and must
    // still render the risk-less next action of a state written by an older build.
    const foreign = makeTask(makeState());
    foreign.state = {
      goal: 'Review the worker',
      status: 'active',
      next: { action: 'Read the diff' },
    };
    expect(renderTaskBrief(foreign).split('\n')).toEqual([
      'Task task-9 [dev-task] (active)',
      'goal: Review the worker',
      'next: Read the diff',
    ]);
  });
});
