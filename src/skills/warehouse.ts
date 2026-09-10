import { z } from 'zod';
import { mergeState } from '../core/state.js';
import type { Skill, StateSchema } from '../core/skill.js';
import type { StateDict } from '../core/types.js';

/** Number of shelves managed by the warehouse skill. */
export const WAREHOUSE_SHELF_COUNT = 500;

/** All state keys in shelf order: shelf_0 .. shelf_499. */
const SHELF_KEYS: readonly string[] = Object.freeze(
  Array.from({ length: WAREHOUSE_SHELF_COUNT }, (_, index) => `shelf_${index}`),
);

/** One shelf slot: an item name, or null/absent when the shelf is empty. */
type ShelfSlot = z.ZodOptional<z.ZodNullable<z.ZodString>>;

/**
 * Static per-domain state schema: a strict flat dict over the 500 shelf keys.
 * `.optional()` is required because the core merge semantics delete a key when
 * a patch sets it to null (SHIP/MAINTAIN), so a shipped shelf is absent from
 * Σ rather than present-with-null; unknown keys still fail validation.
 */
function buildWarehouseSchema(): StateSchema {
  const shape: Record<string, ShelfSlot> = {};
  for (const key of SHELF_KEYS) {
    shape[key] = z.string().nullable().optional();
  }
  return z.strictObject(shape);
}

/**
 * Premature-overwrite guard (the paper's dominant failure mode): a patch may
 * not replace the item on an occupied shelf with a different item. Emptying an
 * occupied shelf (null) and storing into an empty shelf are allowed.
 */
function prematureOverwriteGuard(state: StateDict, patch: StateDict): string | null {
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value !== 'string') continue;
    const current = state[key];
    if (typeof current === 'string' && current !== value) {
      return `premature overwrite of ${key}: holds "${current}", patch sets "${value}"`;
    }
  }
  return null;
}

/** Procedural specification P for the warehouse skill (plain text, multi-line). */
export function warehouseInstructions(): string {
  return `an autonomous warehouse robot managing ${WAREHOUSE_SHELF_COUNT} shelves (shelf_0 through shelf_${WAREHOUSE_SHELF_COUNT - 1}) in a large fulfillment center. Each step you observe exactly one event and must answer with exactly one action and a state patch.

Action space (use these exact formats, one action per step):
- STORE <item> <shelf> — put an incoming item onto a shelf
- SHIP <item> <shelf> — take the ordered item off the shelf that holds it and ship it out
- MAINTAIN <shelf> — repair a shelf; the shelf becomes empty and any item on it is discarded

State semantics:
- The state is a flat JSON dict listing one key per OCCUPIED shelf: shelf_<i> maps to the name of the item stored there (a string).
- A shelf is empty exactly when its key is absent from the state; a key with value null also means empty and is deleted from the state.
- Every action must be reflected in state_patch: STORE sets the target shelf key to the item name; SHIP and MAINTAIN set the target shelf key to null, which deletes that key from the state.

Decision rules:
- "Shipment arrived containing [item]": STORE that item into the lowest-indexed empty shelf (the smallest i such that shelf_i is absent from the state).
- "Customer ordered [item]": SHIP that item from the shelf that currently holds it (the shelf key whose value equals the item name).
- "Maintenance required on [shelf]": MAINTAIN that shelf immediately; it becomes empty.

Answer every event with exactly one action; never combine actions and never skip an event.`;
}

const schema = buildWarehouseSchema();
const instructions = warehouseInstructions();

/** Full warehouse Skill: name, procedural spec P, strict state schema, Σ_0, and guard. */
export function warehouseSkill(): Skill {
  // Sparse Σ_0: only occupied shelves carry keys, so an empty warehouse is {}.
  const initialState: StateDict = {};
  return {
    name: 'warehouse',
    instructions,
    schema,
    initialState,
    guard: prematureOverwriteGuard,
  };
}

/**
 * Deterministic framework-side state update for the Stateful baseline:
 * applies a warehouse action to the state via mergeState. Malformed or
 * unknown actions leave the state unchanged (returned as-is).
 */
export function applyWarehouseAction(state: StateDict, action: string): StateDict {
  const tokens = action.trim().replace(/\s+/g, ' ').split(' ');
  const verb = tokens[0];
  if (verb === undefined || verb === '') return state;

  switch (verb.toUpperCase()) {
    case 'STORE': {
      if (tokens.length < 3) return state;
      const shelf = tokens[tokens.length - 1];
      if (shelf === undefined) return state;
      const item = tokens.slice(1, tokens.length - 1).join(' ');
      return mergeState(state, { [shelf]: item });
    }
    case 'SHIP':
    case 'MAINTAIN': {
      if (tokens.length < 2) return state;
      const shelf = tokens[tokens.length - 1];
      if (shelf === undefined) return state;
      return mergeState(state, { [shelf]: null });
    }
    default:
      return state;
  }
}
