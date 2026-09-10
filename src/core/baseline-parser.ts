import { ParseError } from './parser.js';

/** Matches a trimmed `Action: ...` line, case-insensitively, with loose spacing. */
const ACTION_LINE_RE = /^action\s*:\s*(.*)$/i;

/** Matches a trimmed `Reasoning: ...` line, case-insensitively, with loose spacing. */
const REASONING_LINE_RE = /^reasoning\s*:\s*(.*)$/i;

/** The reasoning trace and action extracted from a baseline (Prompt/ReAct, Memory, Stateful) reply. */
export interface ParsedAction {
  reasoning: string;
  action: string;
}

/** Returns a short, single-line excerpt of `text` for error diagnostics. */
function snippet(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Index of the last line below `limit` whose trimmed form matches `re`, or -1. */
function lastMatchingIndex(lines: readonly string[], re: RegExp, limit: number): number {
  for (let i = limit - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line !== undefined && re.test(line.trim())) {
      return i;
    }
  }
  return -1;
}

/**
 * Parses a baseline-runtime reply of the form `Observation: … / Reasoning: … / Action: …`.
 * The last `Action:` line wins; reasoning is the last `Reasoning:` marker before it plus the
 * lines in between. Text before the reasoning marker and after the action line is ignored.
 */
export function parseActionResponse(raw: string): ParsedAction {
  const lines = raw.split(/\r?\n/);

  const actionIndex = lastMatchingIndex(lines, ACTION_LINE_RE, lines.length);
  if (actionIndex === -1) {
    throw new ParseError('missing-action', `no "Action:" line found in response: ${snippet(raw)}`);
  }

  const actionText = ACTION_LINE_RE.exec((lines[actionIndex] ?? '').trim())?.[1] ?? '';
  const action = actionText.trim();
  if (action === '') {
    throw new ParseError('invalid-action', `"Action:" line has an empty action: ${snippet(raw)}`);
  }

  const reasoningIndex = lastMatchingIndex(lines, REASONING_LINE_RE, actionIndex);
  if (reasoningIndex === -1) {
    return { reasoning: '', action };
  }

  const markerText = REASONING_LINE_RE.exec((lines[reasoningIndex] ?? '').trim())?.[1] ?? '';
  const parts: string[] = [markerText];
  for (let i = reasoningIndex + 1; i < actionIndex; i += 1) {
    parts.push(lines[i] ?? '');
  }

  return { reasoning: parts.join('\n').trim(), action };
}
