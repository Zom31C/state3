import type { StateDict, StateValue } from './types.js';

/** Plain-object test deciding whether a value participates in the recursive merge. */
export function isPlainObject(value: StateValue | undefined): value is StateDict {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge a patch ΔΣ into a state Σ (paper: Σ_{t+1} = Σ_t ⊕ ΔΣ_t).
 * Pure: never mutates its inputs and the result shares no mutable structure
 * with them. A `null` patch value deletes the key; nested plain objects merge
 * recursively; everything else (scalars, arrays) replaces wholesale.
 */
export function mergeState(current: StateDict, patch: StateDict): StateDict {
  const result: StateDict = structuredClone(current);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
      continue;
    }
    const existing = result[key];
    if (isPlainObject(value) && isPlainObject(existing)) {
      result[key] = mergeState(existing, value);
    } else {
      result[key] = structuredClone(value);
    }
  }
  return result;
}

/**
 * A patch key addressing one element of an array field: `plan[2]`,
 * `plan[2].status`, `plan[+]` (append). Only array fields are addressable —
 * plain objects already merge recursively, and dotted keys over them would be
 * ambiguous (`artifacts` keys are file paths).
 */
const PATH_KEY = /^([A-Za-z_][A-Za-z0-9_-]*)\[(\d+|\+)\]((?:\.[A-Za-z_][A-Za-z0-9_-]*)*)$/;

export interface PathTarget {
  field: string;
  /** `'append'` for `[+]`, otherwise the element index. */
  index: number | 'append';
  /** Object keys below the element; empty when the whole element is addressed. */
  tail: readonly string[];
}

/** Parses a path key, or returns null when `key` is an ordinary field name. */
export function parsePathKey(key: string): PathTarget | null {
  const match = PATH_KEY.exec(key);
  if (match === null) return null;
  const field = match[1];
  const rawIndex = match[2];
  const rawTail = match[3];
  if (field === undefined || rawIndex === undefined || rawTail === undefined) return null;
  return {
    field,
    index: rawIndex === '+' ? 'append' : Number(rawIndex),
    tail: rawTail === '' ? [] : rawTail.slice(1).split('.'),
  };
}

export type PathPatchResult = { ok: true; patch: StateDict } | { ok: false; message: string };

function assignAtTail(
  element: StateDict,
  tail: readonly string[],
  value: StateValue,
  key: string,
): string | null {
  let node = element;
  for (let i = 0; i < tail.length - 1; i++) {
    const segment = tail[i];
    if (segment === undefined) continue;
    const child = node[segment];
    if (child === undefined) {
      const created: StateDict = {};
      node[segment] = created;
      node = created;
      continue;
    }
    if (!isPlainObject(child)) {
      return `path "${key}": "${segment}" is not an object, so it has no keys below it`;
    }
    node = child;
  }
  const leaf = tail[tail.length - 1];
  if (leaf === undefined) return `path "${key}": empty key after the index`;
  if (value === null) delete node[leaf];
  else node[leaf] = structuredClone(value);
  return null;
}

/**
 * Rewrites path keys into the wholesale-array patch that `mergeState` expects,
 * so guards and schema validation see one shape only. Pure: `state` is never
 * mutated, and the returned patch shares no structure with it.
 *
 * Why: replacing an array wholesale makes the cost of one plan step proportional
 * to the whole plan, which is expensive for a small-context model. Path keys make
 * it O(step) again without changing the merge semantics of the paper.
 */
export function expandPathPatch(state: StateDict, patch: StateDict): PathPatchResult {
  const expanded: StateDict = {};
  const targeted: { key: string; target: PathTarget; value: StateValue }[] = [];

  for (const [key, value] of Object.entries(patch)) {
    const target = parsePathKey(key);
    if (target === null) expanded[key] = value;
    else targeted.push({ key, target, value });
  }
  if (targeted.length === 0) return { ok: true, patch: expanded };

  const arrays = new Map<string, StateValue[]>();
  for (const { key, target, value } of targeted) {
    if (target.field in expanded) {
      return {
        ok: false,
        message:
          `patch sets "${target.field}" both wholesale and by path ("${key}") — ` +
          'send one of the two, not both',
      };
    }

    let array = arrays.get(target.field);
    if (array === undefined) {
      const current = state[target.field];
      if (!Array.isArray(current)) {
        return {
          ok: false,
          message:
            `path "${key}" needs an array field "${target.field}" in the current state — ` +
            'check the field name with task_show',
        };
      }
      array = structuredClone(current) as StateValue[];
      arrays.set(target.field, array);
    }

    if (target.index === 'append') {
      if (target.tail.length > 0) {
        return { ok: false, message: `path "${key}": [+] appends a whole item and takes no keys` };
      }
      if (value === null) {
        return { ok: false, message: `path "${key}": [+] needs the item to append, not null` };
      }
      array.push(structuredClone(value));
      continue;
    }

    const index = target.index;
    if (index >= array.length) {
      return {
        ok: false,
        message:
          `path "${key}": index ${index} is out of range, "${target.field}" has ` +
          `${array.length} item(s) — use ${target.field}[+] to append`,
      };
    }

    if (target.tail.length === 0) {
      if (value === null) {
        return {
          ok: false,
          message:
            `path "${key}": null cannot remove an array item — send the whole ` +
            `"${target.field}" array without it`,
        };
      }
      array[index] = structuredClone(value);
      continue;
    }

    const element = array[index];
    if (!isPlainObject(element)) {
      return {
        ok: false,
        message: `path "${key}": "${target.field}[${index}]" is not an object`,
      };
    }
    const failure = assignAtTail(element, target.tail, value, key);
    if (failure !== null) return { ok: false, message: failure };
  }

  for (const [field, array] of arrays) expanded[field] = array;
  return { ok: true, patch: expanded };
}

/**
 * Holds the running state Σ plus a single snapshot slot for rollback.
 * Every read returns a deep copy, so callers can never alias internal state.
 */
export class StateStore {
  private current: StateDict;
  private saved: StateDict | null;

  constructor(initial: StateDict) {
    this.current = structuredClone(initial);
    this.saved = null;
  }

  /** Deep copy of the current state. */
  get state(): StateDict {
    return structuredClone(this.current);
  }

  /** Save a deep copy of the current state into the single snapshot slot. */
  snapshot(): void {
    this.saved = structuredClone(this.current);
  }

  /** Snapshot, then merge the patch. Returns a deep copy of the new state. */
  applyPatch(patch: StateDict): StateDict {
    this.snapshot();
    this.current = mergeState(this.current, patch);
    return structuredClone(this.current);
  }

  /**
   * Restore the last snapshot (the slot is kept, so repeated rollback is
   * idempotent). Returns a deep copy of the restored state.
   */
  rollback(): StateDict {
    if (this.saved === null) {
      throw new Error('No snapshot to roll back to');
    }
    this.current = structuredClone(this.saved);
    return structuredClone(this.current);
  }
}
