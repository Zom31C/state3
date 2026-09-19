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
 * A patch key addressing one element of an array field: `plan[2]`, `plan[2].status`,
 * `plan[+]` (append), and `plan[id=5].status` (the element whose own `id` is "5").
 * Only array fields are addressable — plain objects already merge recursively, and
 * dotted keys over them would be ambiguous (`artifacts` keys are file paths).
 */
const PATH_KEY = /^([A-Za-z_][A-Za-z0-9_-]*)\[([^\]]+)\]((?:\.[A-Za-z_][A-Za-z0-9_-]*)*)$/;

/** An index is a position, an id is a name; `[id=…]` exists because they are not the same. */
const ID_SELECTOR = /^id=(.+)$/;

export interface PathTarget {
  field: string;
  /** The element index, `'append'` for `[+]`, or null when the key selects by id. */
  index: number | 'append' | null;
  /** The id named by `[id=…]`, or null for an index and for an append. */
  id: string | null;
  /** Object keys below the element; empty when the whole element is addressed. */
  tail: readonly string[];
}

/** Parses a path key, or returns null when `key` is an ordinary field name. */
export function parsePathKey(key: string): PathTarget | null {
  const match = PATH_KEY.exec(key);
  if (match === null) return null;
  const field = match[1];
  const selector = match[2];
  const rawTail = match[3];
  if (field === undefined || selector === undefined || rawTail === undefined) return null;

  let index: number | 'append' | null = null;
  let id: string | null = null;
  if (selector === '+') {
    index = 'append';
  } else if (/^\d+$/.test(selector)) {
    index = Number(selector);
  } else {
    const byId = ID_SELECTOR.exec(selector);
    const named = byId?.[1]?.trim();
    // Anything else (`plan[foo]`, `plan[]`) is not a path key at all: it stays an
    // unknown top-level key, which the schema refuses with a message that names it.
    if (named === undefined || named === '') return null;
    id = named;
  }

  return {
    field,
    index,
    id,
    tail: rawTail === '' ? [] : rawTail.slice(1).split('.'),
  };
}

export type PathPatchResult = { ok: true; patch: StateDict } | { ok: false; message: string };

/**
 * Lists the top-level keys a patch tries to delete with `null` but that cannot
 * name a state field: they look like a path (dotted or bracketed) yet parse as
 * none.
 *
 * Why: `mergeState` deletes before anything validates, so `{"artifacts.src/":
 * null}` — what an agent writes when it assumes objects are addressable like
 * arrays — used to vanish without a trace while the patch reported success. The
 * agent then keeps reading the entry it believes it removed.
 *
 * A plain key that is merely absent stays legal: domains where "empty" means
 * "not in Σ" (the warehouse shelves) delete idempotently. The check is
 * syntactic, so it needs nothing from the schema.
 */
export function findMalformedDeleteKeys(patch: StateDict): string[] {
  return Object.entries(patch)
    .filter(([key, value]) => value === null && parsePathKey(key) === null && /[.[]/.test(key))
    .map(([key]) => key);
}

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
  if (value === null) {
    if (!(leaf in node)) {
      return (
        `path "${key}": null deletes "${leaf}", which that item does not have — ` +
        'a misspelled key would silently change nothing; task_show prints the current state'
      );
    }
    delete node[leaf];
  } else node[leaf] = structuredClone(value);
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

    const located = locate(array, target, key);
    if (!located.ok) return located;
    const index = located.index;

    if (target.tail.length === 0) {
      if (value === null) {
        // Removing an item shifts every index below it, so a patch that removes two
        // items is applied in the order its keys were written — the order the rest of
        // the patch is read in, and the only one the caller can predict.
        array.splice(index, 1);
        continue;
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

type Located = { ok: true; index: number } | { ok: false; message: string };

/** How many index → id pairs a refusal prints before it becomes noise itself. */
const LIST_LIMIT = 20;

/**
 * The array position a path key addresses.
 *
 * An index is checked against the length; an id is looked up among the items. They are
 * not interchangeable, and confusing them is easy: a plan step whose id is "5" sits at
 * index 4 as soon as the plan is written, so `plan[5].status` is out of range while
 * `plan[id=5].status` names the step the agent meant. Both refusals therefore print the
 * pairing, which is the one thing that turns the refusal into a corrected retry.
 */
function locate(array: readonly StateValue[], target: PathTarget, key: string): Located {
  // The caller handles `[+]` before getting here, so an index that is not a number is an id.
  const index = target.index;
  if (typeof index === 'number') {
    if (index < array.length) return { ok: true, index };
    return {
      ok: false,
      message:
        `path "${key}": index ${index} is out of range, "${target.field}" has ` +
        `${array.length} item(s)${indexIdList(array)} — use ${target.field}[+] to append, ` +
        `or ${target.field}[id=…] to name an item by its id`,
    };
  }

  const id = target.id ?? '';
  const matches: number[] = [];
  array.forEach((item, index) => {
    if (isPlainObject(item) && item.id === id) matches.push(index);
  });

  const first = matches[0];
  if (matches.length === 1 && first !== undefined) return { ok: true, index: first };
  if (matches.length === 0) {
    return {
      ok: false,
      message:
        `path "${key}": no item of "${target.field}" has id "${id}" — an id is not an ` +
        `index${indexIdList(array)}`,
    };
  }
  return {
    ok: false,
    message:
      `path "${key}": ${matches.length} items of "${target.field}" have id "${id}" (indexes ` +
      `${matches.join(', ')}) — send the whole array to change more than one`,
  };
}

/** ` (index → id: 0→"1", 1→"2")`, or an empty string for an array whose items have no id. */
function indexIdList(array: readonly StateValue[]): string {
  const pairs: string[] = [];
  array.forEach((item, index) => {
    if (index >= LIST_LIMIT) return;
    if (isPlainObject(item) && typeof item.id === 'string') pairs.push(`${index}→"${item.id}"`);
  });
  if (pairs.length === 0) return '';
  return ` (index → id: ${pairs.join(', ')}${array.length > LIST_LIMIT ? ', …' : ''})`;
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
