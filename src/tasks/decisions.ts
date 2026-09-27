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

/**
 * The logs a wholesale array key can shorten, and the refusal that now meets one.
 *
 * The note above reports a loss after it happened, and reporting it turned out not to be enough:
 * on 27.09.2026 one agent sent a bare `decisions` key five times in a single session — with the
 * rule printed in every prompt, first as the 504-character tutorial and then as the 213-character
 * reminder that replaced it — and each time the log lost entries that only `task_history` still
 * held. Compressing Σ stays legitimate, so what changed is the moment the rule is enforced: a
 * wholesale key that would drop entries is refused before the write, and rewriting a log whole is
 * something the caller has to say out loud.
 */
export const LOG_FIELDS = ['decisions', 'verifications'] as const;

export type LogField = (typeof LOG_FIELDS)[number];

export function isLogField(value: unknown): value is LogField {
  return typeof value === 'string' && (LOG_FIELDS as readonly string[]).includes(value);
}

/** One log this patch would shorten, and by how much. */
export interface LogShrink {
  field: LogField;
  was: number;
  now: number;
  /** What is no longer there, as text: entry texts for `decisions`, `check` lines for the rest. */
  entries: string[];
}

/** The `check` of a verification entry, which is the part a reader would look for. */
function checkOf(value: StateValue): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const check = (value as { check?: unknown }).check;
  return typeof check === 'string' && check !== '' ? check : null;
}

function entriesOf(value: StateValue | undefined): StateValue[] {
  return Array.isArray(value) ? value : [];
}

/**
 * The logs this patch would shorten *by replacing the array wholesale*, or none.
 *
 * `rawPatch` is the patch as sent, before path keys are expanded, and that is what tells the two
 * intentions apart: `{"decisions[2]": null}` names one entry and means it, while
 * `{"decisions": […]}` means whatever its author remembered to include. Mixing the two for one
 * field is already refused by `expandPathPatch`, so a field is either wholesale or by path.
 *
 * `verifications` is measured by length rather than by content: an entry whose text changed is
 * re-stamped and reported by the stamp note, and refusing a rewording would refuse legitimate
 * work. Shortening is the accident this catches.
 */
export function wholesaleLogShrink(
  before: StateDict,
  rawPatch: StateDict,
  merged: StateDict,
): LogShrink[] {
  const shrinks: LogShrink[] = [];
  for (const field of LOG_FIELDS) {
    if (!(field in rawPatch)) continue;
    const was = entriesOf(before[field]);
    const now = entriesOf(merged[field]);
    if (field === 'verifications') {
      if (now.length >= was.length) continue;
      const kept = new Set(now.map(checkOf));
      shrinks.push({
        field,
        was: was.length,
        now: now.length,
        entries: was
          .map(checkOf)
          .filter((check): check is string => check !== null && !kept.has(check)),
      });
      continue;
    }
    const kept = new Set(now.map(textOf));
    const entries = was.map(textOf).filter((entry) => !kept.has(entry));
    if (entries.length > 0) shrinks.push({ field, was: was.length, now: now.length, entries });
  }
  return shrinks;
}

/**
 * The refusal for a wholesale key that would shorten a log, naming what would leave and the three
 * ways to say what was actually meant.
 *
 * One message for every log the patch touches: a caller that split it across two patches would
 * learn about the second loss only after the first refusal, which is two round trips for one
 * mistake.
 */
export function logShrinkRefusal(shrinks: readonly LogShrink[]): string {
  const parts = shrinks.map((shrink) => {
    const lost = shrink.entries.length;
    const named =
      lost === 0
        ? `${shrink.was - shrink.now} entry(s)`
        : shrink.entries
            .slice(0, REPORT_LIMIT)
            .map((entry) => `"${quote(entry)}"`)
            .join('; ') + (lost > REPORT_LIMIT ? ` and ${lost - REPORT_LIMIT} more` : '');
    return (
      `"${shrink.field}" is append-only and this patch replaces the array wholesale, dropping ` +
      `${lost === 0 ? '' : `${lost} `}entry(s) (${shrink.was} -> ${shrink.now}): ${named}`
    );
  });
  const first = shrinks[0]?.field ?? 'decisions';
  const confirmed = shrinks.map((shrink) => `"${shrink.field}"`).join(', ');
  return (
    `${parts.join('. ')}. Add one with {"${first}[+]":…}, remove one deliberately with ` +
    `{"${first}[3]":null}, or send this patch again with confirm: [${confirmed}] ` +
    '(--confirm in the CLI) to rewrite the log whole. task_history keeps every entry either way.'
  );
}
