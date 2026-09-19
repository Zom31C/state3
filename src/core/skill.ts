import type { StateDict } from './types.js';

export interface SchemaIssue {
  code: string;
  path: readonly PropertyKey[];
  message: string;
  /** Present on a size refusal (`too_big`): the bound the value went past. */
  maximum?: number | bigint;
  /** Present on a size refusal (`too_small`): the bound the value fell short of. */
  minimum?: number | bigint;
}

/**
 * Structural subset of a zod schema's safeParse result. Keeps the core
 * decoupled from zod's generic variance (a zod schema assigns directly).
 */
export interface StateSchema {
  safeParse(
    value: unknown,
  ): { success: true } | { success: false; error: { issues: readonly SchemaIssue[] } };
}

/**
 * Procedural specification P: immutable instructions (persona, action space,
 * environment rules) plus a static per-domain state schema.
 */
export interface Skill {
  name: string;
  instructions: string;
  /** Validates the full state Σ. Use a strict schema so unknown keys fail validation. */
  schema: StateSchema;
  /** Initial state Σ_0. Must pass the schema. */
  initialState: StateDict;
  /** Optional domain guard (e.g. premature-overwrite detection). Returns an error message or null. */
  guard?: (state: StateDict, patch: StateDict) => string | null;
  /**
   * Optional: builds one plan item from a step description, for skills whose Σ
   * has a `plan` array. Without it the skill takes no plan at creation.
   */
  newPlanItem?: (task: string, index: number) => StateDict;
  /** Optional progress counters for list views; treated as 0/0 when absent. */
  progress?: (state: StateDict) => { done: number; total: number };
}
