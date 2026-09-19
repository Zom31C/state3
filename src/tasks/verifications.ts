import { isPlainObject } from '../core/state.js';
import type { StateDict, StateValue } from '../core/types.js';

/** When a verification was recorded, and against which tree. */
export interface VerificationStamp {
  at: string;
  commit: string | null;
}

/**
 * An entry's identity for stamping: everything but the stamp itself.
 *
 * Compared by content rather than by position, because a patch that removes or reorders
 * entries shifts every index after it — and an entry that merely moved is not an entry that
 * was recorded again. Content identity is also what makes the stamp survive a resend of the
 * whole array, which is how a wholesale patch arrives.
 */
function identityOf(item: StateValue): string | null {
  if (!isPlainObject(item)) return null;
  const rest: StateDict = {};
  for (const [key, value] of Object.entries(item)) {
    if (key === 'at' || key === 'commit') continue;
    rest[key] = value;
  }
  return JSON.stringify(rest);
}

/**
 * Stamps the verifications a patch added or changed, in place, before the merged state is
 * validated and written.
 *
 * Why the runtime does it: a check recorded as "pass" is a claim about a tree, and without
 * the time and the commit nobody can tell whether it describes the state before a fix or
 * after it — which is exactly the ambiguity a supervisor diffing a report against `git diff`
 * runs into. The agent cannot supply either value honestly (it does not know HEAD), so
 * asking it to would produce guesses; the runtime knows both.
 *
 * `stamp` is called at most once, and only if something needs stamping: it reads git, and a
 * patch that touches no verification must not pay for a subprocess.
 */
export function stampVerifications(
  before: StateDict,
  merged: StateDict,
  stamp: () => VerificationStamp,
): void {
  const entries = merged.verifications;
  if (!Array.isArray(entries)) return;

  const previous = new Map<
    string,
    { at: StateValue | undefined; commit: StateValue | undefined }
  >();
  const was = Array.isArray(before.verifications) ? before.verifications : [];
  for (const item of was) {
    const identity = identityOf(item);
    if (identity === null || previous.has(identity) || !isPlainObject(item)) continue;
    previous.set(identity, { at: item.at, commit: item.commit });
  }

  let current: VerificationStamp | undefined;
  for (const item of entries) {
    if (!isPlainObject(item)) continue;
    const identity = identityOf(item);
    const carried = identity === null ? undefined : previous.get(identity);
    if (carried !== undefined) {
      // Unchanged since it was recorded: keep the stamp it had. An entry written by a build
      // that had no stamps stays unstamped rather than claiming to be new.
      if (carried.at !== undefined) item.at = carried.at;
      if (carried.commit !== undefined) item.commit = carried.commit;
      continue;
    }
    if (current === undefined) current = stamp();
    item.at = current.at;
    item.commit = current.commit;
  }
}
