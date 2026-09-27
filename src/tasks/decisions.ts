/**
 * What a patch cost the append-only log, and the report that says so.
 *
 * `decisions` is documented as append-only in every task skill, and `finish()` already relies on
 * that contract being common to all of them. But a patch replaces an array wholesale, so a shorter
 * array drops every entry that is not in it, and nothing in Σ says which those were: after the
 * write, the log holds only what survived.
 *
 * A note rather than a refusal, for the reason the verification stamps are a note: compressing Σ is
 * legitimate and refusing it would leave the state growing forever. What must not happen is the
 * loss being silent — so the answer names the entries that left, and the history keeps them in
 * full, which is the only place they still exist.
 */

import type { StateDict, StateValue } from '../core/types.js';

/** How many dropped entries one answer names before the list stops being readable. */
const REPORT_LIMIT = 5;

/** Characters of an entry quoted in the answer; the history holds it whole. */
const ENTRY_QUOTE_CHARS = 80;

/** The entries a patch took out of the log. */
export interface DroppedDecisions {
  /** How many entries the log had before the patch. */
  was: number;
  /** How many it has after it. */
  now: number;
  /** The texts that are no longer in Σ, in the order the log held them. */
  entries: string[];
}

/** An entry as text, whatever a skill's schema says it is. */
function textOf(value: StateValue): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? String(value);
}

function quote(entry: string): string {
  const trimmed = entry.trim();
  return trimmed.length <= ENTRY_QUOTE_CHARS ? trimmed : `${trimmed.slice(0, ENTRY_QUOTE_CHARS)}…`;
}

/**
 * The entries the log lost to a patch, or null when it lost none.
 *
 * Compared by content, not by length or position: appending, resending the whole array and
 * reordering it are all silent, and an entry that was *reworded* counts as lost, because the text
 * that was there is gone from Σ just as thoroughly as a deleted one. A state with no such array —
 * a skill whose Σ has no log — is not a loss.
 */
export function droppedDecisions(before: StateDict, merged: StateDict): DroppedDecisions | null {
  if (!Array.isArray(before.decisions)) return null;
  const was = before.decisions.map(textOf);
  const now = Array.isArray(merged.decisions) ? merged.decisions.map(textOf) : [];
  const kept = new Set(now);
  const entries = was.filter((entry) => !kept.has(entry));
  if (entries.length === 0) return null;
  return { was: was.length, now: now.length, entries };
}

/** The dropped entries in full, as one line for the audit trail; null when nothing was dropped. */
export function decisionsHistoryNote(dropped: DroppedDecisions | null): string | null {
  if (dropped === null) return null;
  const listed = dropped.entries.map((entry) => `"${entry.trim()}"`).join('; ');
  return (
    `${dropped.entries.length} decisions entry(s) left Σ ` +
    `(${dropped.was} -> ${dropped.now}): ${listed}`
  );
}

/**
 * The lines a patch answer adds for the entries the log lost; empty when it lost none.
 *
 * Quotes a few and counts the rest, like the stamp report does: the answer is read on the turn
 * the loss happened, and a wall of quoted text there costs the same attention the warning needs.
 * The full text is one `task_history` call away, and the line says so.
 */
export function decisionsWarnings(dropped: DroppedDecisions | null): string[] {
  if (dropped === null) return [];
  const shown = dropped.entries.slice(0, REPORT_LIMIT);
  const more =
    dropped.entries.length > shown.length
      ? ` and ${dropped.entries.length - shown.length} more`
      : '';
  return [
    `Note: ${dropped.entries.length} decisions entry(s) are no longer in Σ ` +
      `(${dropped.was} -> ${dropped.now})${more}: ` +
      shown.map((entry) => `"${quote(entry)}"`).join('; ') +
      '. `decisions` is append-only by contract, but a patch replaces the array wholesale, so an ' +
      'entry missing from it is gone from the state — including one that was only reworded. ' +
      'task_history keeps this line with the entries in full.',
  ];
}
