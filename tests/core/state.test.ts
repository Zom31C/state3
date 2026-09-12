import { describe, expect, it } from 'vitest';
import {
  expandPathPatch,
  findMalformedDeleteKeys,
  mergeState,
  parsePathKey,
  StateStore,
} from '../../src/core/state.js';
import type { StateDict } from '../../src/core/types.js';

describe('mergeState', () => {
  it('adds new keys', () => {
    expect(mergeState({ a: 1 }, { b: 'x' })).toEqual({ a: 1, b: 'x' });
  });

  it('replaces scalars wholesale, including across types', () => {
    expect(mergeState({ a: 1, b: 'old', c: true }, { a: 2, b: 'new' })).toEqual({
      a: 2,
      b: 'new',
      c: true,
    });
    expect(mergeState({ a: 1 }, { a: { x: 1 } })).toEqual({ a: { x: 1 } });
    expect(mergeState({ a: { x: 1 } }, { a: 5 })).toEqual({ a: 5 });
  });

  it('deletes a top-level key when the patch value is null', () => {
    const result = mergeState({ a: 1, b: 2 }, { b: null });
    expect(result).toEqual({ a: 1 });
    expect('b' in result).toBe(false);
  });

  it('deletes a nested key when null appears inside a nested patch', () => {
    const result = mergeState({ shelf: { x: 1, y: 2 } }, { shelf: { y: null } });
    expect(result).toEqual({ shelf: { x: 1 } });
    expect('y' in (result.shelf as StateDict)).toBe(false);
  });

  it('merges nested plain objects recursively', () => {
    const current = { room: { light: 'off', table: { cups: 1 } } };
    const patch = { room: { table: { teapot: true }, window: 'open' } };
    expect(mergeState(current, patch)).toEqual({
      room: { light: 'off', table: { cups: 1, teapot: true }, window: 'open' },
    });
  });

  it('replaces arrays wholesale instead of merging element-wise', () => {
    expect(mergeState({ list: [1, 2, 3] }, { list: [4] })).toEqual({ list: [4] });
    expect(mergeState({ nested: { items: ['a', 'b'] } }, { nested: { items: [] } })).toEqual({
      nested: { items: [] },
    });
    expect(mergeState({ a: { x: 1 } }, { a: [1] })).toEqual({ a: [1] });
  });

  it('preserves keys not mentioned in the patch', () => {
    const result = mergeState({ a: { x: 1 }, b: [1, 2], c: 's' }, { c: 't' });
    expect(result).toEqual({ a: { x: 1 }, b: [1, 2], c: 't' });
  });

  it('does not mutate its inputs', () => {
    const current: StateDict = { a: 1, nested: { x: 1, list: [1] } };
    const patch: StateDict = { nested: { x: 2, y: null }, added: [3] };
    const currentBefore = structuredClone(current);
    const patchBefore = structuredClone(patch);
    mergeState(current, patch);
    expect(current).toEqual(currentBefore);
    expect(patch).toEqual(patchBefore);
  });

  it('returns a result that shares no mutable structure with its inputs', () => {
    const current: StateDict = { nested: { x: 1 }, list: [1] };
    const patch: StateDict = { other: { y: 2 } };
    const result = mergeState(current, patch);
    (result.nested as StateDict).x = 99;
    (result.list as number[]).push(7);
    (result.other as StateDict).y = 100;
    expect(current).toEqual({ nested: { x: 1 }, list: [1] });
    expect(patch).toEqual({ other: { y: 2 } });
  });

  it('keeps an existing null value in current when the patch does not mention the key', () => {
    expect(mergeState({ shelf: null, count: 1 }, { count: 2 })).toEqual({
      shelf: null,
      count: 2,
    });
  });
});

describe('findMalformedDeleteKeys', () => {
  it('flags a dotted key, which no field can be', () => {
    expect(findMalformedDeleteKeys({ 'artifacts.src/': null })).toEqual(['artifacts.src/']);
  });

  it('flags a bracketed key that parses as no path', () => {
    expect(findMalformedDeleteKeys({ 'plan[x]': null })).toEqual(['plan[x]']);
  });

  it('leaves a valid path key for path expansion to judge', () => {
    expect(findMalformedDeleteKeys({ 'plan[0].notes': null })).toEqual([]);
  });

  it('leaves a plain key alone, so deleting an absent one stays idempotent', () => {
    expect(findMalformedDeleteKeys({ shelf_7: null, blockers: null })).toEqual([]);
  });

  it('ignores values that are not null, which the schema rejects on its own', () => {
    expect(findMalformedDeleteKeys({ 'artifacts.src/': 'x' })).toEqual([]);
  });
});

describe('StateStore', () => {
  it('deep-copies the initial state passed to the constructor', () => {
    const initial: StateDict = { a: { x: 1 } };
    const store = new StateStore(initial);
    (initial.a as StateDict).x = 99;
    expect(store.state).toEqual({ a: { x: 1 } });
  });

  it('returns a fresh deep copy from the state getter', () => {
    const store = new StateStore({ a: { x: 1 } });
    const first = store.state;
    const second = store.state;
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    (first.a as StateDict).x = 42;
    expect(store.state).toEqual({ a: { x: 1 } });
  });

  it('applyPatch updates the state and returns a deep copy of the new state', () => {
    const store = new StateStore({ a: 1, nested: { x: 1 } });
    const patch: StateDict = { a: 2, nested: { x: 2 } };
    const next = store.applyPatch(patch);
    expect(next).toEqual({ a: 2, nested: { x: 2 } });
    expect(store.state).toEqual({ a: 2, nested: { x: 2 } });
    next.a = 99;
    (patch.nested as StateDict).x = 99;
    expect(store.state).toEqual({ a: 2, nested: { x: 2 } });
  });

  it('rollback after applyPatch restores the previous state', () => {
    const store = new StateStore({ a: 1, b: { y: 1 } });
    store.applyPatch({ a: 2, b: { y: null } });
    expect(store.state).toEqual({ a: 2, b: {} });
    const restored = store.rollback();
    expect(restored).toEqual({ a: 1, b: { y: 1 } });
    expect(store.state).toEqual({ a: 1, b: { y: 1 } });
  });

  it('rollback without a snapshot throws with the exact message', () => {
    const store = new StateStore({ a: 1 });
    let thrown: unknown = null;
    try {
      store.rollback();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('No snapshot to roll back to');
  });

  it('snapshot then applyPatch then rollback restores the snapshotted state', () => {
    const store = new StateStore({ a: 1 });
    store.snapshot();
    store.applyPatch({ a: 2 });
    const restored = store.rollback();
    expect(restored).toEqual({ a: 1 });
    expect(store.state).toEqual({ a: 1 });
  });

  it('repeated rollback is idempotent and keeps the snapshot slot', () => {
    const store = new StateStore({ a: 1 });
    store.applyPatch({ a: 2 });
    const first = store.rollback();
    const second = store.rollback();
    expect(first).toEqual({ a: 1 });
    expect(second).toEqual({ a: 1 });
    expect(store.state).toEqual({ a: 1 });
    second.a = 99;
    expect(store.state.a).toBe(1);
  });

  it('keeps only the latest snapshot (single slot, overwrites)', () => {
    const store = new StateStore({ a: 1 });
    store.snapshot();
    store.applyPatch({ a: 2 });
    store.applyPatch({ a: 3 });
    expect(store.rollback()).toEqual({ a: 2 });
  });
});

describe('parsePathKey', () => {
  it('parses an index, a tail of keys, and the append marker', () => {
    expect(parsePathKey('plan[2]')).toEqual({ field: 'plan', index: 2, tail: [] });
    expect(parsePathKey('plan[2].status')).toEqual({
      field: 'plan',
      index: 2,
      tail: ['status'],
    });
    expect(parsePathKey('runs[0].review.verdict')).toEqual({
      field: 'runs',
      index: 0,
      tail: ['review', 'verdict'],
    });
    expect(parsePathKey('plan[+]')).toEqual({ field: 'plan', index: 'append', tail: [] });
  });

  it('leaves ordinary and dotted field names alone', () => {
    expect(parsePathKey('goal')).toBeNull();
    expect(parsePathKey('next')).toBeNull();
    expect(parsePathKey('INTEGRATION.md')).toBeNull();
    expect(parsePathKey('artifacts.src/tasks/store.ts')).toBeNull();
    expect(parsePathKey('plan[2')).toBeNull();
    expect(parsePathKey('plan.2.status')).toBeNull();
  });
});

describe('expandPathPatch', () => {
  const plan = [
    { id: '1', task: 'a', status: 'done', notes: '' },
    { id: '2', task: 'b', status: 'pending', notes: '' },
  ];

  /** mergeState returns StateDict; the assertions below need to look inside its arrays. */
  const mergedRows = (state: StateDict, patch: StateDict): Record<string, unknown[]> =>
    mergeState(state, patch) as unknown as Record<string, unknown[]>;

  it('passes a patch without path keys through untouched', () => {
    const result = expandPathPatch({ plan }, { goal: 'x', artifacts: { 'a.md': 'y' } });
    expect(result).toEqual({ ok: true, patch: { goal: 'x', artifacts: { 'a.md': 'y' } } });
  });

  it('expands one element write into the whole array, so merging it is a no-op elsewhere', () => {
    const result = expandPathPatch({ plan }, { 'plan[1].status': 'in_progress' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(mergeState({ plan }, result.patch)).toEqual({
      plan: [plan[0], { id: '2', task: 'b', status: 'in_progress', notes: '' }],
    });
    expect(plan[1]).toEqual({ id: '2', task: 'b', status: 'pending', notes: '' });
  });

  it('costs the touched item, not the array: the patch is smaller than the wholesale form', () => {
    const result = expandPathPatch({ plan }, { 'plan[1].status': 'done' });
    expect(JSON.stringify({ 'plan[1].status': 'done' }).length).toBeLessThan(
      JSON.stringify({ plan }).length,
    );
    expect(result.ok).toBe(true);
  });

  it('accumulates several path keys for the same field', () => {
    const result = expandPathPatch(
      { plan },
      {
        'plan[0].notes': 'shipped',
        'plan[1].status': 'in_progress',
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(mergeState({ plan }, result.patch)).toEqual({
      plan: [
        { id: '1', task: 'a', status: 'done', notes: 'shipped' },
        { id: '2', task: 'b', status: 'in_progress', notes: '' },
      ],
    });
  });

  it('replaces a whole element and appends with [+]', () => {
    const replaced = expandPathPatch({ plan }, { 'plan[0]': { id: '1', task: 'z' } });
    expect(replaced.ok).toBe(true);
    if (replaced.ok) {
      expect(mergedRows({ plan }, replaced.patch).plan?.[0]).toEqual({ id: '1', task: 'z' });
    }
    const appended = expandPathPatch({ plan }, { 'plan[+]': { id: '3', task: 'c' } });
    expect(appended.ok).toBe(true);
    if (appended.ok) {
      expect(mergedRows({ plan }, appended.patch).plan).toHaveLength(3);
    }
  });

  it('creates missing objects below the element and deletes a key on null', () => {
    const state = { runs: [{ id: '1', review: { verdict: 'reject' } }] };
    const created = expandPathPatch(state, { 'runs[0].review.note': 'no tests' });
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(mergedRows(state, created.patch).runs?.[0]).toEqual({
        id: '1',
        review: { verdict: 'reject', note: 'no tests' },
      });
    }
    const bare = { runs: [{ id: '1' }] };
    const deep = expandPathPatch(bare, { 'runs[0].review.verdict': 'accept' });
    expect(deep.ok).toBe(true);
    if (deep.ok) {
      expect(mergedRows(bare, deep.patch).runs?.[0]).toEqual({
        id: '1',
        review: { verdict: 'accept' },
      });
    }
    const removed = expandPathPatch(state, { 'runs[0].review.verdict': null });
    expect(removed.ok).toBe(true);
    if (removed.ok) {
      expect(mergedRows(state, removed.patch).runs?.[0]).toEqual({ id: '1', review: {} });
    }
  });

  it('rejects null on a key the element does not have instead of silently doing nothing', () => {
    const state = { plan: [{ id: '1', notes: 'old' }] };
    const result = expandPathPatch(state, { 'plan[0].note': null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('plan[0].note');
      expect(result.message).toContain('does not have');
    }
  });

  it('rejects a path into a field that is not an array in the current state', () => {
    const result = expandPathPatch({ goal: 'x', plan }, { 'goal[0]': 'y' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('needs an array field "goal"');
  });

  it('rejects an out-of-range index and points at [+]', () => {
    const result = expandPathPatch({ plan }, { 'plan[5].status': 'done' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('out of range');
      expect(result.message).toContain('plan[+]');
    }
  });

  it('rejects mixing a wholesale field with a path into it', () => {
    const result = expandPathPatch({ plan }, { plan: [], 'plan[0].status': 'done' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('both wholesale and by path');
  });

  it('rejects null on an element and on [+], which cannot express removal', () => {
    const element = expandPathPatch({ plan }, { 'plan[0]': null });
    expect(element.ok).toBe(false);
    if (!element.ok) expect(element.message).toContain('cannot remove an array item');
    const append = expandPathPatch({ plan }, { 'plan[+]': null });
    expect(append.ok).toBe(false);
    if (!append.ok) expect(append.message).toContain('needs the item to append');
  });

  it('rejects keys below [+] and paths into a non-object element', () => {
    const tail = expandPathPatch({ plan }, { 'plan[+].status': 'done' });
    expect(tail.ok).toBe(false);
    if (!tail.ok) expect(tail.message).toContain('takes no keys');
    const scalar = expandPathPatch({ blockers: ['a'] }, { 'blockers[0].x': 1 });
    expect(scalar.ok).toBe(false);
    if (!scalar.ok) expect(scalar.message).toContain('is not an object');
  });
});
