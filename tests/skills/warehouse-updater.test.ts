import { describe, expect, it } from 'vitest';
import type { StateDict } from '../../src/core/types.js';
import { applyWarehouseAction, warehouseSkill } from '../../src/skills/warehouse.js';

/** The full initial state with selected shelf keys overridden. */
function stateWith(overrides: StateDict): StateDict {
  return { ...warehouseSkill().initialState, ...overrides };
}

describe('applyWarehouseAction — STORE', () => {
  it('sets the target shelf key to the item name', () => {
    const next = applyWarehouseAction(stateWith({ shelf_7: null }), 'STORE Item_1 shelf_7');
    expect(next.shelf_7).toBe('Item_1');
  });

  it('joins every token between the verb and the shelf into a multi-word item', () => {
    const next = applyWarehouseAction(warehouseSkill().initialState, 'store red box shelf_3');
    expect(next.shelf_3).toBe('red box');
  });

  it('uppercases only the verb, preserving item and shelf casing', () => {
    const next = applyWarehouseAction(warehouseSkill().initialState, 'sToRe Item_1 Shelf_2');
    expect(next.Shelf_2).toBe('Item_1');
    expect('shelf_2' in next).toBe(false);
  });

  it('trims the action and collapses internal whitespace runs', () => {
    const next = applyWarehouseAction(warehouseSkill().initialState, '  STORE   Item_1   shelf_2 ');
    expect(next.shelf_2).toBe('Item_1');
  });

  it('adds an unknown shelf key (mergeState semantics, no schema validation)', () => {
    const state = warehouseSkill().initialState;
    const next = applyWarehouseAction(state, 'STORE Item_1 shelf_500');
    expect(next.shelf_500).toBe('Item_1');
    expect('shelf_500' in state).toBe(false);
  });

  it('keeps every other shelf untouched', () => {
    const state = stateWith({ shelf_0: 'Item_0', shelf_1: 'Item_1' });
    const next = applyWarehouseAction(state, 'STORE Item_2 shelf_2');
    expect(next).toEqual({ ...state, shelf_2: 'Item_2' });
  });
});

describe('applyWarehouseAction — SHIP and MAINTAIN', () => {
  it('SHIP deletes the shelf key, leaving the shelf empty', () => {
    const next = applyWarehouseAction(stateWith({ shelf_3: 'Item_2' }), 'SHIP Item_2 shelf_3');
    expect('shelf_3' in next).toBe(false);
    expect(next.shelf_3).toBeUndefined();
  });

  it('SHIP ignores the item token and uses the last token as the shelf', () => {
    const next = applyWarehouseAction(stateWith({ shelf_9: 'Item_8' }), 'ship Item_8 shelf_9');
    expect('shelf_9' in next).toBe(false);
  });

  it('MAINTAIN deletes the shelf key even when it holds an item', () => {
    const next = applyWarehouseAction(stateWith({ shelf_4: 'Item_4' }), 'MAINTAIN shelf_4');
    expect('shelf_4' in next).toBe(false);
  });

  it('MAINTAIN on an already-absent shelf is a no-op copy', () => {
    const state: StateDict = { shelf_0: 'Item_0' };
    const next = applyWarehouseAction(state, 'MAINTAIN shelf_1');
    expect(next).toEqual({ shelf_0: 'Item_0' });
    expect(next).not.toBe(state);
  });

  it('keeps every other shelf untouched', () => {
    const state = stateWith({ shelf_0: 'Item_0', shelf_1: 'Item_1', shelf_2: 'Item_2' });
    const expected = structuredClone(state);
    delete expected.shelf_1;
    expect(applyWarehouseAction(state, 'SHIP Item_1 shelf_1')).toEqual(expected);
  });
});

describe('applyWarehouseAction — malformed actions', () => {
  it('returns the identical state reference for malformed or unknown actions', () => {
    const state = stateWith({ shelf_0: 'Item_0' });
    for (const action of ['', '   ', 'DANCE shelf_1', 'STORE', 'STORE Item_1', 'MAINTAIN']) {
      expect(applyWarehouseAction(state, action)).toBe(state);
    }
  });

  it('returns the identical state reference for an unknown verb with enough tokens', () => {
    const state = stateWith({ shelf_0: 'Item_0' });
    expect(applyWarehouseAction(state, 'SHIP_IT Item_0 shelf_0')).toBe(state);
    expect(applyWarehouseAction(state, 'MAINTAINER shelf_0')).toBe(state);
  });
});

describe('applyWarehouseAction — purity', () => {
  it('never mutates the input state', () => {
    const state = stateWith({ shelf_0: 'Item_0', shelf_1: 'Item_1' });
    const before = structuredClone(state);
    applyWarehouseAction(state, 'STORE Item_9 shelf_2');
    applyWarehouseAction(state, 'SHIP Item_0 shelf_0');
    applyWarehouseAction(state, 'MAINTAIN shelf_1');
    expect(state).toEqual(before);
  });

  it('returns a state independent of the input', () => {
    const state = stateWith({ shelf_4: 'Item_4' });
    const next = applyWarehouseAction(state, 'STORE Item_5 shelf_5');
    expect(next).not.toBe(state);
    next.shelf_4 = 'MUTATED';
    delete next.shelf_5;
    expect(state.shelf_4).toBe('Item_4');
    expect('shelf_5' in state).toBe(false);
  });

  it('applies actions in sequence without aliasing intermediate states', () => {
    const expected = structuredClone(warehouseSkill().initialState);
    delete expected.shelf_0;
    expected.shelf_1 = 'Item_1';
    let state = warehouseSkill().initialState;
    state = applyWarehouseAction(state, 'STORE Item_0 shelf_0');
    state = applyWarehouseAction(state, 'STORE Item_1 shelf_1');
    state = applyWarehouseAction(state, 'SHIP Item_0 shelf_0');
    expect(state).toEqual(expected);
    expect('shelf_0' in state).toBe(false);
    expect(state.shelf_1).toBe('Item_1');
  });
});
