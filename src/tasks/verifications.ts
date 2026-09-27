import { isPlainObject } from '../core/state.js';
import type { StateDict, StateValue } from '../core/types.js';

/** When a verification was recorded, and against which tree. */
export interface VerificationStamp {
  at: string;
  commit: string | null;
}

/**
 * A stamp this patch detached from the entry it was recorded against, with the check it
 * belonged to.
 *
 * The values are reported rather than kept because nothing else holds them: `task_history`
 * stores the patch as the agent sent it, and an agent is told never to send `at` or
 * `commit`, so once the runtime overwrites a stamp the previous one exists only in this
 * report. Dropping it silently is how a record ends up claiming "PASS at 21:54 commit
 * 8842a54" for a run that happened on ea6f494.
 */
export interface SupersededStamp {
  check: string;
  at: string;
  commit: string | null;
}

/** What stamping one patch did, for the answer and the audit trail. */
export interface StampReport {
  /** Entries that kept the stamp they were recorded with. */
  carried: number;
  /** Entries stamped with this patch's time and HEAD. */
  stamped: number;
  /** Previous stamps no longer attached to any entry, oldest first. */
  superseded: SupersededStamp[];
}

const NO_STAMPS: StampReport = { carried: 0, stamped: 0, superseded: [] };

/** How many superseded stamps one answer names before the list stops being readable. */
const REPORT_LIMIT = 5;

/** Characters of a check quoted in the report; the full text is in Σ and in the history. */
const CHECK_QUOTE_CHARS = 80;

/**
 * A value whose key order carries no meaning, so two records of the same fact compare equal.
 *
 * `JSON.stringify` writes keys in insertion order, and the order an agent happens to type
 * them in is not part of what it recorded: `{"check":"npm test","status":"pass"}` and
 * `{"status":"pass","check":"npm test"}` are the same entry. Comparing them as unequal
 * re-stamped a check that had not been run again — the exact loss the stamp exists to
 * prevent, caused by nothing but the shape of the resend.
 */
function canonical(value: StateValue): StateValue {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isPlainObject(value)) return value;
  const sorted: StateDict = {};
  const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : 1));
  for (const [key, nested] of entries) sorted[key] = canonical(nested);
  return sorted;
}

/**
 * An entry's identity for stamping: everything but the stamp itself, in canonical form.
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
  return JSON.stringify(canonical(rest));
}

/** One previous entry, as the report needs it: its stamp and the check it described. */
interface PreviousEntry {
  at: StateValue | undefined;
  commit: StateValue | undefined;
  check: string;
}

/** A stamp read out of Σ, tolerating a value no string was ever written to. */
function stampOf(entry: PreviousEntry): VerificationStamp | null {
  if (typeof entry.at !== 'string') return null;
  return {
    at: entry.at,
    commit: typeof entry.commit === 'string' ? entry.commit : null,
  };
}

function quote(check: string): string {
  const trimmed = check.trim();
  return trimmed.length <= CHECK_QUOTE_CHARS ? trimmed : `${trimmed.slice(0, CHECK_QUOTE_CHARS)}…`;
}

/**
 * Stamps the verifications a patch added or changed, in place, before the merged state is
 * validated and written, and reports what that cost.
 *
 * Why the runtime does it: a check recorded as "pass" is a claim about a tree, and without
 * the time and the commit nobody can tell whether it describes the state before a fix or
 * after it — which is exactly the ambiguity a supervisor diffing a report against `git diff`
 * runs into. The agent cannot supply either value honestly (it does not know HEAD), so
 * asking it to would produce guesses; the runtime knows both.
 *
 * An entry whose content is unchanged keeps the stamp it had, which is what lets Σ be
 * compressed by resending the array. An entry whose content changed is a new claim and is
 * stamped again — including when only its wording moved, because the runtime cannot tell a
 * reworded check from a different one. That is why the report lists the stamps a patch
 * detached: the loss is legitimate, but it must not be silent.
 *
 * `stamp` is called at most once, and only if something needs stamping: it reads git, and a
 * patch that touches no verification must not pay for a subprocess.
 */
export function stampVerifications(
  before: StateDict,
  merged: StateDict,
  stamp: () => VerificationStamp,
): StampReport {
  const entries = merged.verifications;
  if (!Array.isArray(entries)) return NO_STAMPS;

  const previous = new Map<string, PreviousEntry>();
  const was = Array.isArray(before.verifications) ? before.verifications : [];
  for (const item of was) {
    if (!isPlainObject(item)) continue;
    const identity = identityOf(item);
    if (identity === null || previous.has(identity)) continue;
    previous.set(identity, {
      at: item.at,
      commit: item.commit,
      check: typeof item.check === 'string' ? item.check : '',
    });
  }

  const report: StampReport = { carried: 0, stamped: 0, superseded: [] };
  const kept = new Set<string>();
  let current: VerificationStamp | undefined;
  for (const item of entries) {
    if (!isPlainObject(item)) continue;
    const identity = identityOf(item);
    const carried = identity === null ? undefined : previous.get(identity);
    if (carried !== undefined && identity !== null) {
      // Unchanged since it was recorded: keep the stamp it had. An entry written by a build
      // that had no stamps stays unstamped rather than claiming to be new.
      kept.add(identity);
      if (carried.at !== undefined) item.at = carried.at;
      if (carried.commit !== undefined) item.commit = carried.commit;
      report.carried += 1;
      continue;
    }
    if (current === undefined) current = stamp();
    item.at = current.at;
    item.commit = current.commit;
    report.stamped += 1;
  }

  for (const [identity, entry] of previous) {
    if (kept.has(identity)) continue;
    const lost = stampOf(entry);
    // An entry written before stamps existed has nothing to lose.
    if (lost === null) continue;
    report.superseded.push({ check: entry.check, at: lost.at, commit: lost.commit });
  }

  return report;
}

/** The stamps a patch detached, as one line for the audit trail; null when it detached none. */
export function stampHistoryNote(report: StampReport): string | null {
  if (report.superseded.length === 0) return null;
  const listed = report.superseded
    .map((lost) => `"${quote(lost.check)}" was at ${lost.at} commit ${lost.commit ?? 'null'}`)
    .join('; ');
  return `${report.superseded.length} verification stamp(s) superseded: ${listed}`;
}

/**
 * The lines a patch answer adds for the stamps it detached; empty when it detached none.
 *
 * A note rather than a refusal: shortening a check's wording is a legitimate edit, and refusing it
 * would leave Σ uncompressed. The values are named because the answer and the history are the only
 * places they still exist.
 *
 * What the note does *not* carry is the lesson — that a resent entry keeps its stamp while a
 * reworded one is a new claim. That is in P, where it is read once per task instead of once per
 * patch, and repeating it here made the note longer than the state it was annotating.
 */
export function stampWarnings(report: StampReport): string[] {
  if (report.superseded.length === 0) return [];
  const shown = report.superseded.slice(0, REPORT_LIMIT);
  const more =
    report.superseded.length > shown.length
      ? ` and ${report.superseded.length - shown.length} more`
      : '';
  return [
    `Note: ${report.superseded.length} verification stamp(s) are no longer attached to an entry${more}: ` +
      shown
        .map((lost) => `"${quote(lost.check)}" was at ${lost.at} commit ${lost.commit ?? 'null'}`)
        .join('; ') +
      '. A reworded check is a new claim and was stamped with this patch; task_history keeps this ' +
      'line and the values it names.',
  ];
}
