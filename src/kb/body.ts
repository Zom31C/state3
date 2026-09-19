/**
 * Text surgery on a page body.
 *
 * A page was only writable whole: `put` with a new `body`. That made every small
 * correction cost the entire text — a model re-types five thousand characters to
 * change two lines, and can lose a paragraph while doing it. The cheaper and safer
 * shape is the one an editor uses: name the piece to change, and the piece it
 * becomes.
 *
 * Three edits, because they cover what a knowledge base actually needs:
 *
 * - `find`/`replace` — the general case;
 * - `after`/`insert` — add a line below an anchor without retyping what follows;
 * - `section`/`body` — replace everything between one heading and the next.
 *
 * Two rules make an edit safe to accept from a model. A `find` or an anchor must
 * match EXACTLY once: a match that is not unique would let an edit land somewhere
 * the caller did not mean, which is worse than a refusal, because the body then
 * reads as if it were intended. And a refused edit changes nothing at all: the
 * edits of one call are applied to a copy and discarded together, so a body is
 * never left half-edited.
 */

/** One call carries a handful of edits; a hundred of them is a rewrite, which is `put`. */
export const MAX_BODY_EDITS = 20;

export interface ReplaceEdit {
  find: string;
  replace: string;
}

export interface InsertEdit {
  after: string;
  insert: string;
}

export interface SectionEdit {
  section: string;
  body: string;
}

export type BodyEdit = ReplaceEdit | InsertEdit | SectionEdit;

export type BodyEditsResult = { ok: true; edits: BodyEdit[] } | { ok: false; message: string };

export type BodyEditResult =
  | { ok: true; body: string }
  /** `index` is zero-based; the messages that reach an agent number edits from 1. */
  | { ok: false; index: number; message: string };

function isReplaceEdit(edit: BodyEdit): edit is ReplaceEdit {
  return 'find' in edit;
}

function isInsertEdit(edit: BodyEdit): edit is InsertEdit {
  return 'after' in edit;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const EDIT_FORMS = [
  { keys: ['find', 'replace'], name: 'find/replace' },
  { keys: ['after', 'insert'], name: 'after/insert' },
  { keys: ['section', 'body'], name: 'section/body' },
] as const;

/**
 * Reads the `edits` argument of `page {"op":"patch"}`.
 *
 * Validated here rather than by zod: an edit is one of three shapes sharing no
 * discriminator field, and a union of three strict objects reports "invalid input"
 * where the caller needs "edit 2 has both find and after". Every refusal names the
 * edit by its position, because a list of edits is exactly where a model loses
 * track of which one it meant.
 */
export function parseBodyEdits(raw: unknown): BodyEditsResult {
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      message:
        'edits must be an array of edits, each one of ' +
        EDIT_FORMS.map((form) => `{${form.keys.join(', ')}}`).join(' or ') +
        ` (at most ${MAX_BODY_EDITS})`,
    };
  }
  if (raw.length === 0) {
    return { ok: false, message: 'edits must hold at least one edit — nothing to change' };
  }
  if (raw.length > MAX_BODY_EDITS) {
    return {
      ok: false,
      message: `edits holds ${raw.length} edits, limit ${MAX_BODY_EDITS} — rewrite the body with op "put" instead`,
    };
  }

  const edits: BodyEdit[] = [];
  for (const [position, item] of raw.entries()) {
    const parsed = parseOneEdit(item, position);
    if (!parsed.ok) return parsed;
    edits.push(parsed.edit);
  }
  return { ok: true, edits };
}

function parseOneEdit(
  item: unknown,
  position: number,
): { ok: true; edit: BodyEdit } | { ok: false; message: string } {
  const at = `edit ${position + 1}`;
  if (!isRecord(item)) {
    return { ok: false, message: `${at} must be an object, not ${describe(item)}` };
  }

  const keys = Object.keys(item);
  const form = EDIT_FORMS.find((candidate) => candidate.keys.every((key) => keys.includes(key)));
  if (form === undefined) {
    return { ok: false, message: `${at} ${shapeRefusal(keys)}` };
  }

  const extra = keys.filter((key) => !(form.keys as readonly string[]).includes(key));
  if (extra.length > 0) {
    return {
      ok: false,
      message:
        `${at} ${shapeRefusal(keys)} — ${extra.map(quote).join(', ')} does not belong to ` +
        `a ${form.name} edit`,
    };
  }

  const values: Record<string, string> = {};
  for (const key of form.keys) {
    const value = item[key];
    if (typeof value !== 'string') {
      return { ok: false, message: `${at}: "${key}" must be a string, not ${describe(value)}` };
    }
    values[key] = value;
  }

  // The first field of every form is an address into the text, and an empty address
  // matches everywhere. The second is what goes in, and only a section body may be
  // empty — that is how a section is cleared.
  const [addressKey, payloadKey] = form.keys;
  if (addressKey !== undefined && values[addressKey]?.trim() === '') {
    return { ok: false, message: `${at}: "${addressKey}" must not be empty` };
  }
  if (payloadKey !== undefined && payloadKey !== 'body' && values[payloadKey] === '') {
    return { ok: false, message: `${at}: "${payloadKey}" must not be empty` };
  }

  const edit = values as unknown as BodyEdit;
  return { ok: true, edit };
}

function quote(key: string): string {
  return `"${key}"`;
}

/**
 * The shapes an edit may have, and which of the sent keys do not fit any of them.
 * Listing the shapes is what turns "invalid edit" into a retry that succeeds: the
 * three forms are close enough to confuse, and a model that mixed two of them needs
 * to see both the form it reached for and the key that gave it away.
 */
function shapeRefusal(keys: readonly string[]): string {
  const shapes = EDIT_FORMS.map((form) => `{${form.keys.join(', ')}}`).join(', ');
  const known = new Set<string>(EDIT_FORMS.flatMap((form) => [...form.keys]));
  const unknown = keys.filter((key) => !known.has(key));
  const detail =
    unknown.length === 0
      ? ''
      : ` — ${unknown.map(quote).join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not edit fields`;
  return `must be exactly one of ${shapes} (got: {${keys.join(', ')}})${detail}`;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

/**
 * Applies every edit in order, each to the result of the previous one, so a later
 * edit may address text an earlier one inserted. Nothing is written until all of
 * them succeeded: the caller keeps the stored body when this returns `ok: false`.
 */
export function applyBodyEdits(body: string, edits: readonly BodyEdit[]): BodyEditResult {
  let current = body;
  for (const [index, edit] of edits.entries()) {
    const result = applyOne(current, edit);
    if (!result.ok) return { ok: false, index, message: result.message };
    current = result.body;
  }
  return { ok: true, body: current };
}

function applyOne(
  body: string,
  edit: BodyEdit,
): { ok: true; body: string } | { ok: false; message: string } {
  if (isReplaceEdit(edit)) return replaceOnce(body, edit);
  if (isInsertEdit(edit)) return insertAfter(body, edit);
  return replaceSection(body, edit);
}

/** How many times `needle` occurs in `haystack`, without overlapping matches. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

/**
 * The refusal an edit gets when its address does not name exactly one place. Both
 * cases point at the same fix — copy the text from `page get` — because a model
 * that typed the anchor from memory is the reason the match failed.
 */
function matchFailure(what: string, needle: string, found: number): string {
  const shown = needle.length > 60 ? `${needle.slice(0, 57)}...` : needle;
  if (found === 0) {
    return (
      `${what} "${shown}" matches nothing in the body — copy it verbatim from ` +
      'page {"op":"get"}, including whitespace and line breaks'
    );
  }
  return (
    `${what} "${shown}" matches ${found} times — send more surrounding text so the ` +
    'match is unique, or address the section it is in with a section edit'
  );
}

function replaceOnce(
  body: string,
  edit: ReplaceEdit,
): { ok: true; body: string } | { ok: false; message: string } {
  const found = countOccurrences(body, edit.find);
  if (found !== 1) return { ok: false, message: matchFailure('find', edit.find, found) };
  const at = body.indexOf(edit.find);
  return {
    ok: true,
    body: body.slice(0, at) + edit.replace + body.slice(at + edit.find.length),
  };
}

/**
 * Inserts on the line below the anchor's line, not in the middle of it: the anchor
 * is a heading or a list item in practice, and text spliced into the middle of a
 * line would corrupt the line it was found in.
 */
function insertAfter(
  body: string,
  edit: InsertEdit,
): { ok: true; body: string } | { ok: false; message: string } {
  const found = countOccurrences(body, edit.after);
  if (found !== 1) return { ok: false, message: matchFailure('after', edit.after, found) };

  const matchEnd = body.indexOf(edit.after) + edit.after.length;
  const lineEnd = endOfLine(body, matchEnd);
  const text = edit.insert.replace(/^\n+/, '');
  return { ok: true, body: `${body.slice(0, lineEnd)}\n${text}${body.slice(lineEnd)}` };
}

interface Heading {
  level: number;
  title: string;
  /** Index of the first character of the heading's line. */
  lineStart: number;
  /** Index just past the heading's line, before its line break. */
  lineEnd: number;
}

/** An ATX heading, with or without its closing `#` run; indented up to three spaces. */
const HEADING_LINE = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t#]*\r?$/;

function headingsOf(body: string): Heading[] {
  const found: Heading[] = [];
  let lineStart = 0;
  for (const line of body.split('\n')) {
    const lineEnd = lineStart + line.length;
    const match = HEADING_LINE.exec(line);
    const hashes = match?.[1];
    const title = match?.[2];
    if (hashes !== undefined && title !== undefined) {
      found.push({ level: hashes.length, title, lineStart, lineEnd });
    }
    lineStart = lineEnd + 1;
  }
  return found;
}

/** Heading text as a caller names it: without the `#` run, and without letter case. */
function normalizeHeading(text: string): string {
  return text
    .trim()
    .replace(/^#+[ \t]*/, '')
    .replace(/[ \t#]+$/, '')
    .trim()
    .toLowerCase();
}

/** Index just past the line containing `at`, or the end of the body. */
function endOfLine(body: string, at: number): number {
  const next = body.indexOf('\n', at);
  return next === -1 ? body.length : next;
}

/**
 * Replaces the text of one heading's section: everything from the heading's line up
 * to the next heading of the same or a higher level, or to the end of the body. A
 * subsection therefore travels with its section, which is what "replace the section"
 * has to mean for a tree of headings to stay a tree.
 */
function replaceSection(
  body: string,
  edit: SectionEdit,
): { ok: true; body: string } | { ok: false; message: string } {
  const wanted = normalizeHeading(edit.section);
  const headings = headingsOf(body);
  const matches = headings.filter((heading) => normalizeHeading(heading.title) === wanted);

  if (matches.length === 0) {
    const available = headings.map((heading) => heading.title.trim());
    return {
      ok: false,
      message:
        `section "${edit.section}" matches no heading in the body` +
        (available.length === 0
          ? ' — the body has no headings, so use a find/replace edit'
          : ` (headings: ${available
              .slice(0, 12)
              .map((title) => `"${title}"`)
              .join(', ')}${available.length > 12 ? ', ...' : ''})`),
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      message: `section "${edit.section}" matches ${matches.length} headings — rename one of them, or use a find/replace edit`,
    };
  }

  const heading = matches[0];
  if (heading === undefined) return { ok: false, message: `section "${edit.section}" not found` };

  const sectionEnd =
    headings.find((next) => next.lineStart > heading.lineStart && next.level <= heading.level)
      ?.lineStart ?? body.length;

  const head = body.slice(0, heading.lineEnd);
  const rest = body.slice(sectionEnd);
  const text = edit.body.replace(/^\n+/, '').replace(/\s+$/, '');
  // One blank line before the next heading, so a replaced section cannot weld two
  // headings together; nothing after the last one.
  return { ok: true, body: `${head}\n${text}${rest === '' ? '' : `\n\n${rest}`}` };
}

/**
 * Adds text at the end of a body, one blank line below what was there — the common
 * case for a note page ("measurement of …"). An empty body takes the text as it is,
 * so appending to a page that has none does not start it with a blank line.
 */
export function appendToBody(body: string, text: string): string {
  const addition = text.replace(/^\n+/, '');
  if (body.trim() === '') return addition;
  return `${body.replace(/\s+$/, '')}\n\n${addition}`;
}
