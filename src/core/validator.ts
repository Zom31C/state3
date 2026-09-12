import type { PatchRejectCategory } from './rejections.js';
import type { SchemaIssue, Skill } from './skill.js';
import type { StateDict } from './types.js';
import { findMalformedDeleteKeys, mergeState } from './state.js';

/**
 * The categories this validator can report. It is a subset of the shared
 * vocabulary: `path` comes from path expansion and `skill` from the store's
 * skill lookup, both of which run around this function.
 */
export type ValidationErrorCategory = Extract<
  PatchRejectCategory,
  'guard' | 'unknown-key' | 'type-coercion' | 'schema'
>;

export type ValidationResult =
  { ok: true } | { ok: false; category: ValidationErrorCategory; message: string };

/**
 * Deterministically checks a candidate patch ΔΣ against the skill schema by
 * validating the merged result Σ ⊕ ΔΣ. Never mutates the live state.
 */
export function validatePatch(skill: Skill, state: StateDict, patch: StateDict): ValidationResult {
  const guardError = skill.guard?.(state, patch);
  if (guardError !== undefined && guardError !== null) {
    return { ok: false, category: 'guard', message: guardError };
  }

  const malformedDeletes = findMalformedDeleteKeys(patch);
  if (malformedDeletes.length > 0) {
    return {
      ok: false,
      category: 'unknown-key',
      message:
        'State validation failed: ' +
        `${malformedDeletes.map((key) => `"${key}"`).join(', ')} is not a field and not a path key, ` +
        'so deleting it would silently change nothing — only array fields take path keys ' +
        '("plan[0].notes"); to delete a key inside an object send it nested ' +
        '({"artifacts": {"the/key": null}}).',
    };
  }

  const candidate = mergeState(state, patch);
  const parsed = skill.schema.safeParse(candidate);
  if (parsed.success) return { ok: true };

  const issue = parsed.error.issues[0];
  if (issue === undefined) {
    return { ok: false, category: 'schema', message: 'State schema validation failed.' };
  }
  return { ok: false, category: issueCategory(issue.code), message: formatIssue(issue) };
}

/**
 * Maps a zod issue code onto the shared rejection vocabulary. Exported because the
 * knowledge base validates with zod too, and one mapping keeps a `type-coercion`
 * meaning the same thing whichever layer refused the write.
 */
export function issueCategory(code: string): ValidationErrorCategory {
  switch (code) {
    case 'unrecognized_keys':
      return 'unknown-key';
    case 'invalid_type':
      return 'type-coercion';
    default:
      return 'schema';
  }
}

function formatIssue(issue: SchemaIssue): string {
  const at = issue.path.length > 0 ? `at "${issue.path.join('.')}" ` : '';
  return `State validation failed ${at}(${issue.code}): ${issue.message}`;
}
