import { describe, expect, it } from 'vitest';
import { mergeState } from '../../src/core/state.js';
import type { StateDict } from '../../src/core/types.js';
import { validatePatch } from '../../src/core/validator.js';
import {
  WAREHOUSE_SHELF_COUNT,
  warehouseInstructions,
  warehouseSkill,
} from '../../src/skills/warehouse.js';

/** The full initial state with selected shelf keys overridden. */
function stateWith(overrides: StateDict): StateDict {
  return { ...warehouseSkill().initialState, ...overrides };
}

describe('warehouseSkill', () => {
  it("is named 'warehouse'", () => {
    expect(warehouseSkill().name).toBe('warehouse');
  });

  it('exposes 500 shelves and starts with an empty sparse state', () => {
    expect(WAREHOUSE_SHELF_COUNT).toBe(500);
    expect(warehouseSkill().initialState).toEqual({});
  });

  it('returns a fresh initialState object per call', () => {
    expect(warehouseSkill().initialState).toEqual(warehouseSkill().initialState);
    expect(warehouseSkill().initialState).not.toBe(warehouseSkill().initialState);
  });

  it('initialState passes its own schema', () => {
    const skill = warehouseSkill();
    expect(skill.schema.safeParse(skill.initialState).success).toBe(true);
  });

  it('schema accepts item names and null values on shelf keys', () => {
    const skill = warehouseSkill();
    const state = stateWith({ shelf_0: 'Item_0', shelf_499: null });
    expect(skill.schema.safeParse(state).success).toBe(true);
  });

  it('schema rejects unknown keys', () => {
    const skill = warehouseSkill();
    expect(skill.schema.safeParse(stateWith({ shelf_500: null })).success).toBe(false);
    expect(skill.schema.safeParse(stateWith({ robot: 'wall-e' })).success).toBe(false);
  });

  it('schema rejects non-string shelf values', () => {
    const skill = warehouseSkill();
    for (const value of [42, true, ['Item_0'], { item: 'x' }]) {
      expect(skill.schema.safeParse(stateWith({ shelf_7: value })).success).toBe(false);
    }
  });

  it('schema accepts a shelf deleted by a null patch (core merge semantics)', () => {
    const skill = warehouseSkill();
    const stored = mergeState(skill.initialState, { shelf_0: 'Item_0' });
    expect(skill.schema.safeParse(stored).success).toBe(true);
    const shipped = mergeState(stored, { shelf_0: null });
    expect('shelf_0' in shipped).toBe(false);
    expect(skill.schema.safeParse(shipped).success).toBe(true);
  });
});

describe('premature-overwrite guard', () => {
  it('rejects replacing the item on an occupied shelf with a different one', () => {
    const skill = warehouseSkill();
    expect(skill.guard?.(stateWith({ shelf_3: 'Item_2' }), { shelf_3: 'Item_9' })).toBe(
      'premature overwrite of shelf_3: holds "Item_2", patch sets "Item_9"',
    );
  });

  it('allows emptying an occupied shelf (SHIP / MAINTAIN)', () => {
    const skill = warehouseSkill();
    expect(skill.guard?.(stateWith({ shelf_3: 'Item_2' }), { shelf_3: null })).toBeNull();
  });

  it('allows storing into an empty shelf, whether null or absent', () => {
    const skill = warehouseSkill();
    expect(skill.guard?.(skill.initialState, { shelf_10: 'Item_4' })).toBeNull();
    const state: StateDict = { ...skill.initialState };
    delete state.shelf_10;
    expect(skill.guard?.(state, { shelf_10: 'Item_4' })).toBeNull();
  });

  it('allows patching a shelf to the item it already holds', () => {
    const skill = warehouseSkill();
    expect(skill.guard?.(stateWith({ shelf_3: 'Item_2' }), { shelf_3: 'Item_2' })).toBeNull();
  });

  it('allows an empty patch and leaves non-string values to the schema', () => {
    const skill = warehouseSkill();
    expect(skill.guard?.(stateWith({ shelf_3: 'Item_2' }), {})).toBeNull();
    expect(skill.guard?.(stateWith({ shelf_3: 'Item_2' }), { shelf_3: 7 })).toBeNull();
  });

  it('reports the first conflicting key of a multi-key patch', () => {
    const skill = warehouseSkill();
    const state = stateWith({ shelf_1: 'Item_0', shelf_2: 'Item_1' });
    expect(skill.guard?.(state, { shelf_1: 'Item_5', shelf_2: 'Item_6' })).toBe(
      'premature overwrite of shelf_1: holds "Item_0", patch sets "Item_5"',
    );
  });
});

describe('warehouseInstructions', () => {
  it('documents persona, action formats, state semantics, and shelf count', () => {
    const text = warehouseInstructions();
    expect(text).toContain('500');
    expect(text).toContain('STORE <item> <shelf>');
    expect(text).toContain('SHIP <item> <shelf>');
    expect(text).toContain('MAINTAIN <shelf>');
    expect(text).toContain('shelf_0');
    expect(text).toContain('shelf_499');
    expect(text.toLowerCase()).toContain('robot');
    expect(text).toContain('null');
    expect(text).toContain('exactly one action');
  });

  it('is the instructions text carried by the skill', () => {
    expect(warehouseSkill().instructions).toBe(warehouseInstructions());
  });
});

describe('warehouseSkill with the core validator', () => {
  it('accepts a STORE patch into an empty shelf', () => {
    const skill = warehouseSkill();
    expect(validatePatch(skill, skill.initialState, { shelf_0: 'Item_0' })).toEqual({ ok: true });
  });

  it('accepts a SHIP patch that nulls an occupied shelf', () => {
    const skill = warehouseSkill();
    expect(validatePatch(skill, stateWith({ shelf_0: 'Item_0' }), { shelf_0: null })).toEqual({
      ok: true,
    });
  });

  it('rejects a premature overwrite as a guard error', () => {
    const skill = warehouseSkill();
    const result = validatePatch(skill, stateWith({ shelf_0: 'Item_0' }), { shelf_0: 'Item_1' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.category).toBe('guard');
      expect(result.message).toBe(
        'premature overwrite of shelf_0: holds "Item_0", patch sets "Item_1"',
      );
    }
  });

  it('rejects an unknown key as unknown-key', () => {
    const skill = warehouseSkill();
    const result = validatePatch(skill, skill.initialState, { shelf_500: 'Item_0' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.category).toBe('unknown-key');
    }
  });

  it('rejects a wrong value type as type-coercion', () => {
    const skill = warehouseSkill();
    const result = validatePatch(skill, skill.initialState, { shelf_0: 123 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.category).toBe('type-coercion');
    }
  });
});
