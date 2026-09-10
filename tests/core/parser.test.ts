import { describe, expect, it } from 'vitest';
import { ParseError, parseStepResponse } from '../../src/core/parser.js';
import type { ParseErrorCode } from '../../src/core/parser.js';

/** Wraps `body` in a ``` fence, optionally with a language tag. */
function fenced(body: string, lang = 'json'): string {
  return '```' + lang + '\n' + body + '\n```';
}

/** Asserts that parsing `raw` throws a ParseError carrying `code`. */
function expectParseError(raw: string, code: ParseErrorCode): void {
  try {
    parseStepResponse(raw);
  } catch (err) {
    expect(err).toBeInstanceOf(ParseError);
    expect((err as ParseError).code).toBe(code);
    return;
  }
  throw new Error(`expected ParseError(${code}) but parsing succeeded`);
}

describe('parseStepResponse', () => {
  it('parses a paper-format response with reasoning around a json fence', () => {
    const raw =
      'First I should record progress, then continue.\n' +
      fenced('{"state_patch": {"progress": 0.5}, "action": "CONTINUE"}') +
      '\nThat is my decision.';

    expect(parseStepResponse(raw)).toEqual({
      statePatch: { progress: 0.5 },
      action: 'CONTINUE',
    });
  });

  it('parses a fence without a language tag', () => {
    const raw = 'Reasoning here.\n' + fenced('{"state_patch": {}, "action": "DONE"}', '');

    expect(parseStepResponse(raw)).toEqual({ statePatch: {}, action: 'DONE' });
  });

  it('uses the last object-valued fence when several are present', () => {
    const raw =
      fenced('{"state_patch": {"a": 1}, "action": "first"}') +
      '\ninterleaved prose\n' +
      fenced('{"state_patch": {"b": 2}, "action": "second"}');

    expect(parseStepResponse(raw)).toEqual({ statePatch: { b: 2 }, action: 'second' });
  });

  it('prefers the last object fence even when a later fence is not an object', () => {
    const raw = fenced('{"state_patch": {"a": 1}, "action": "only"}') + '\n' + fenced('[1, 2, 3]');

    expect(parseStepResponse(raw)).toEqual({ statePatch: { a: 1 }, action: 'only' });
  });

  it('finds JSON embedded in prose via the balanced-brace scan when there are no fences', () => {
    const raw = 'The model says {"state_patch": {"x": 1}, "action": "go"} and then stops.';

    expect(parseStepResponse(raw)).toEqual({ statePatch: { x: 1 }, action: 'go' });
  });

  it('parses nested objects and arrays inside state_patch', () => {
    const raw = fenced(
      '{"state_patch": {"nested": {"a": [1, 2, {"b": null}]}, "flag": true}, "action": "go"}',
    );

    expect(parseStepResponse(raw)).toEqual({
      statePatch: { nested: { a: [1, 2, { b: null }] }, flag: true },
      action: 'go',
    });
  });

  it('does not break the balanced scan on braces and escaped quotes inside string values', () => {
    const raw =
      'Answer: {"state_patch": {"msg": "has { and } and \\"quotes\\""}, "action": "go"} done';

    expect(parseStepResponse(raw)).toEqual({
      statePatch: { msg: 'has { and } and "quotes"' },
      action: 'go',
    });
  });

  it('repairs a single trailing comma', () => {
    const raw = 'Result: {"state_patch": {"a": 1,}, "action": "x",}';

    expect(parseStepResponse(raw)).toEqual({ statePatch: { a: 1 }, action: 'x' });
  });

  it('tolerates extra keys in the response object', () => {
    const raw = fenced('{"state_patch": {"a": 1}, "action": "go", "confidence": 0.9}');

    expect(parseStepResponse(raw)).toEqual({ statePatch: { a: 1 }, action: 'go' });
  });

  it('accepts an empty state_patch', () => {
    const raw = fenced('{"state_patch": {}, "action": "noop"}');

    expect(parseStepResponse(raw)).toEqual({ statePatch: {}, action: 'noop' });
  });

  it('returns the trimmed action', () => {
    const raw = fenced('{"state_patch": {}, "action": "   go   "}');

    expect(parseStepResponse(raw).action).toBe('go');
  });

  it('throws no-json-found when the response has no braces at all', () => {
    expectParseError('just prose, nothing structured here', 'no-json-found');
  });

  it('throws json-syntax on unrecoverable malformed JSON', () => {
    expectParseError('{"state_patch": {"a": 1} "action": "x"}', 'json-syntax');
  });

  it('throws json-syntax when the top-level value is an array', () => {
    expectParseError(fenced('[1, 2, 3]'), 'json-syntax');
  });

  it('throws missing-state-patch when the key is absent', () => {
    expectParseError(fenced('{"action": "go"}'), 'missing-state-patch');
  });

  it('throws missing-action when the key is absent', () => {
    expectParseError(fenced('{"state_patch": {}}'), 'missing-action');
  });

  it('throws invalid-state-patch when state_patch is an array', () => {
    expectParseError(fenced('{"state_patch": [1], "action": "go"}'), 'invalid-state-patch');
  });

  it('throws invalid-state-patch when state_patch is null', () => {
    expectParseError(fenced('{"state_patch": null, "action": "go"}'), 'invalid-state-patch');
  });

  it('throws invalid-action when action is not a string', () => {
    expectParseError(fenced('{"state_patch": {}, "action": 42}'), 'invalid-action');
  });

  it('throws invalid-action when action is an empty string', () => {
    expectParseError(fenced('{"state_patch": {}, "action": ""}'), 'invalid-action');
  });

  it('throws invalid-action when action is whitespace only', () => {
    expectParseError(fenced('{"state_patch": {}, "action": "   "}'), 'invalid-action');
  });

  it('includes a diagnostic snippet in the error message', () => {
    try {
      parseStepResponse(fenced('{"action": "go"}'));
      throw new Error('expected a ParseError');
    } catch (err) {
      expect((err as ParseError).message).toContain('state_patch');
    }
  });

  it('exposes name and code on ParseError', () => {
    const err = new ParseError('json-syntax', 'boom');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ParseError');
    expect(err.code).toBe('json-syntax');
  });
});
