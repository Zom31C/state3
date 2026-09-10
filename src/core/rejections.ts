/**
 * The diagnostic vocabulary a rejected write is reported with.
 *
 * One source of truth on purpose. Three layers reject a patch (path expansion,
 * the domain guard plus schema validation, the store looking up the skill), one
 * layer turns a rejection into a hint for the agent, and the procedure P tells
 * the agent what each category means. Hand-copied lists of these names drift: P
 * once named five categories while the store threw six, so an agent following P
 * could not interpret the rejection it actually got. P and the hint table are
 * therefore generated from this array, and a new category cannot be added
 * without the compiler and the tests asking for its hint and its mention in P.
 */
export const PATCH_REJECT_CATEGORIES = [
  'guard',
  'path',
  'unknown-key',
  'type-coercion',
  'schema',
  'skill',
] as const;

/** Categories a `patch` can be rejected with — exactly the ones P must name. */
export type PatchRejectCategory = (typeof PATCH_REJECT_CATEGORIES)[number];

/** `start` can additionally reject a notation it does not know. */
export const REJECT_CATEGORIES = [...PATCH_REJECT_CATEGORIES, 'notation'] as const;

export type RejectCategory = (typeof REJECT_CATEGORIES)[number];

/** Narrows a category read back from disk or from an unknown error. */
export function isRejectCategory(value: unknown): value is RejectCategory {
  return typeof value === 'string' && (REJECT_CATEGORIES as readonly string[]).includes(value);
}

/** The list as P prints it: every category a patch can be rejected with. */
export function patchCategoryList(): string {
  return PATCH_REJECT_CATEGORIES.join(', ');
}
