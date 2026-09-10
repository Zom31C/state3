import type { StateDict } from './types.js';

/** A single parsed SKILL.state step: the state patch ΔΣ and the chosen action. */
export interface ParsedStep {
  statePatch: StateDict;
  action: string;
}

export type ParseErrorCode =
  | 'no-json-found'
  | 'json-syntax'
  | 'missing-state-patch'
  | 'missing-action'
  | 'invalid-state-patch'
  | 'invalid-action';

/** Thrown when a model response cannot be turned into a valid {@link ParsedStep}. */
export class ParseError extends Error {
  readonly code: ParseErrorCode;

  constructor(code: ParseErrorCode, message: string) {
    super(message);
    this.name = 'ParseError';
    this.code = code;
  }
}

/** True when `value` is a non-null, non-array plain object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns a short, single-line excerpt of `text` for error diagnostics. */
function snippet(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Extracts the contents of every fenced code block (``` with an optional
 * language tag). Returns them in order of appearance.
 */
function extractFences(raw: string): string[] {
  const fences: string[] = [];
  const fenceRe = /```[^\n]*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(raw)) !== null) {
    const content = match[1];
    if (content !== undefined) {
      fences.push(content);
    }
  }
  return fences;
}

/**
 * Scans for the substring that starts at the first `{` and ends at its
 * matching `}`, tracking brace depth and JSON string/escape state so that
 * braces and quotes inside string values do not break the scan. Returns null
 * if no balanced object exists.
 */
function balancedScan(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === undefined) {
      break;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * JSON.parse with exactly one repair attempt: trailing commas before `}` or
 * `]` are stripped, then the text is re-parsed. Throws if both attempts fail.
 */
function parseWithRepair(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(text.replace(/,(\s*[}\]])/g, '$1'));
  }
}

/** Validates the parsed top-level object and produces a {@link ParsedStep}. */
function validateStep(obj: Record<string, unknown>): ParsedStep {
  const statePatch = obj['state_patch'];
  if (statePatch === undefined) {
    throw new ParseError(
      'missing-state-patch',
      `response has no state_patch key: ${snippet(JSON.stringify(obj))}`,
    );
  }
  if (!isPlainObject(statePatch)) {
    throw new ParseError(
      'invalid-state-patch',
      `state_patch must be a JSON object: ${snippet(JSON.stringify(statePatch))}`,
    );
  }

  const action = obj['action'];
  if (action === undefined) {
    throw new ParseError(
      'missing-action',
      `response has no action key: ${snippet(JSON.stringify(obj))}`,
    );
  }
  if (typeof action !== 'string') {
    throw new ParseError(
      'invalid-action',
      `action must be a string: ${snippet(JSON.stringify(action))}`,
    );
  }
  const trimmedAction = action.trim();
  if (trimmedAction === '') {
    throw new ParseError(
      'invalid-action',
      `action must be a non-empty string: ${snippet(JSON.stringify(action))}`,
    );
  }

  // JSON.parse output is inherently JSON-safe, so the cast is sound.
  return { statePatch: statePatch as StateDict, action: trimmedAction };
}

/**
 * Parses a raw model response into a {@link ParsedStep}. Prefers the last
 * fenced code block that is a JSON object, falls back to a balanced-brace
 * scan, repairs a single trailing-comma error, and validates the structure.
 */
export function parseStepResponse(raw: string): ParsedStep {
  const fences = extractFences(raw);

  let lastObject: Record<string, unknown> | null = null;
  let nonObjectFence: string | null = null;
  for (const fence of fences) {
    let value: unknown;
    try {
      value = parseWithRepair(fence);
    } catch {
      continue;
    }
    if (isPlainObject(value)) {
      lastObject = value;
    } else if (nonObjectFence === null) {
      nonObjectFence = fence;
    }
  }

  if (lastObject !== null) {
    return validateStep(lastObject);
  }

  // A fence parsed to valid JSON but not to an object: that is a structural
  // error, not "no JSON found", so report it instead of falling through.
  if (nonObjectFence !== null) {
    throw new ParseError(
      'json-syntax',
      `top-level JSON value is not an object: ${snippet(nonObjectFence)}`,
    );
  }

  const candidate = balancedScan(raw);
  if (candidate === null) {
    throw new ParseError('no-json-found', `no JSON object found in response: ${snippet(raw)}`);
  }

  let value: unknown;
  try {
    value = parseWithRepair(candidate);
  } catch {
    throw new ParseError('json-syntax', `invalid JSON in response: ${snippet(candidate)}`);
  }
  if (!isPlainObject(value)) {
    throw new ParseError(
      'json-syntax',
      `top-level JSON value is not an object: ${snippet(candidate)}`,
    );
  }
  return validateStep(value);
}
