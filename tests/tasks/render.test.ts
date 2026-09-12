import { describe, expect, it } from 'vitest';
import type { StateDict } from '../../src/core/types.js';
import type { Notation } from '../../src/tasks/notation.js';
import type { DevTaskState } from '../../src/tasks/schema.js';
import {
  STATE_SIZE_HINT_CHARS,
  renderTaskBrief,
  renderTaskHead,
  stateSizeHint,
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
