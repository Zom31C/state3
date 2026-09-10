import { describe, expect, it } from 'vitest';
import type { StateDict } from '../../src/core/types.js';
import type { Notation } from '../../src/tasks/notation.js';
import type { DevTaskState } from '../../src/tasks/schema.js';
import { STATE_SIZE_HINT_CHARS, renderTaskHead, stateSizeHint } from '../../src/tasks/render.js';
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
