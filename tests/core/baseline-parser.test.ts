import { describe, expect, it } from 'vitest';
import { ParseError } from '../../src/core/parser.js';
import type { ParseErrorCode } from '../../src/core/parser.js';
import { parseActionResponse } from '../../src/core/baseline-parser.js';

/** Asserts that parsing `raw` throws a ParseError carrying `code`. */
function expectParseError(raw: string, code: ParseErrorCode): void {
  try {
    parseActionResponse(raw);
  } catch (err) {
    expect(err).toBeInstanceOf(ParseError);
    expect((err as ParseError).code).toBe(code);
    return;
  }
  throw new Error(`expected ParseError(${code}) but parsing succeeded`);
}

describe('parseActionResponse', () => {
  it('parses the canonical Observation/Reasoning/Action response', () => {
    const raw = 'Observation: o\nReasoning: r\nAction: STORE Item_0 shelf_0';

    expect(parseActionResponse(raw)).toEqual({
      reasoning: 'r',
      action: 'STORE Item_0 shelf_0',
    });
  });

  it('returns empty reasoning for a continuation-style reply with no markers but Action', () => {
    const raw =
      'The shelf is empty, so I should store the next item there.\nAction: STORE Item_1 shelf_2';

    expect(parseActionResponse(raw)).toEqual({
      reasoning: '',
      action: 'STORE Item_1 shelf_2',
    });
  });

  it('joins multi-line reasoning with newlines', () => {
    const raw =
      'Observation: o\n' +
      'Reasoning: first line\n' +
      'second line\n' +
      'third line\n' +
      'Action: CONTINUE';

    expect(parseActionResponse(raw)).toEqual({
      reasoning: 'first line\nsecond line\nthird line',
      action: 'CONTINUE',
    });
  });

  it('trims surrounding whitespace from the joined reasoning', () => {
    const raw = 'Reasoning:   r  \n\n  \nAction: DONE';

    expect(parseActionResponse(raw).reasoning).toBe('r');
  });

  it('ignores extra prose before the reasoning marker and after the action line', () => {
    const raw =
      'Here is my thinking about the situation.\n' +
      'Observation: o\n' +
      'Reasoning: r\n' +
      'Action: MOVE shelf_0\n' +
      'That is my final decision, thanks.';

    expect(parseActionResponse(raw)).toEqual({ reasoning: 'r', action: 'MOVE shelf_0' });
  });

  it('accepts a lowercase action marker', () => {
    expect(parseActionResponse('action: GO').action).toBe('GO');
  });

  it('accepts an uppercase marker with a space before the colon', () => {
    expect(parseActionResponse('ACTION : GO').action).toBe('GO');
  });

  it('accepts an indented marker with trailing spaces', () => {
    expect(parseActionResponse('  Action: x  ').action).toBe('x');
  });

  it('accepts a lowercase reasoning marker with loose spacing', () => {
    const raw = '  reasoning   :    r\nAction: GO';

    expect(parseActionResponse(raw)).toEqual({ reasoning: 'r', action: 'GO' });
  });

  it('handles CRLF line endings', () => {
    const raw = 'Observation: o\r\nReasoning: r1\r\nr2\r\nAction: GO\r\n';

    expect(parseActionResponse(raw)).toEqual({ reasoning: 'r1\nr2', action: 'GO' });
  });

  it('uses the last Action line when several are present', () => {
    const raw = 'Reasoning: early\n' + 'Action: FIRST\n' + 'Reasoning: late\n' + 'Action: SECOND\n';

    expect(parseActionResponse(raw)).toEqual({ reasoning: 'late', action: 'SECOND' });
  });

  it('keeps the reasoning marker closest to the winning Action line', () => {
    const raw = 'Reasoning: a\nReasoning: b\nextra\nAction: GO';

    expect(parseActionResponse(raw)).toEqual({ reasoning: 'b\nextra', action: 'GO' });
  });

  it('does not treat a Reasoning marker after the action line as reasoning', () => {
    const raw = 'Action: GO\nReasoning: too late';

    expect(parseActionResponse(raw)).toEqual({ reasoning: '', action: 'GO' });
  });

  it('returns empty reasoning when the marker line has no text and nothing follows', () => {
    const raw = 'Reasoning:\nAction: GO';

    expect(parseActionResponse(raw)).toEqual({ reasoning: '', action: 'GO' });
  });

  it('throws missing-action when no action line exists', () => {
    expectParseError('Observation: o\nReasoning: r\nnothing to do here', 'missing-action');
  });

  it('throws invalid-action when the action marker has no text', () => {
    expectParseError('Reasoning: r\nAction:', 'invalid-action');
  });

  it('throws invalid-action when the action is whitespace only', () => {
    expectParseError('Reasoning: r\nAction:    ', 'invalid-action');
  });

  it('includes a diagnostic snippet in the missing-action message', () => {
    try {
      parseActionResponse('Observation: o\nReasoning: r\nsome trailing prose');
      throw new Error('expected a ParseError');
    } catch (err) {
      expect(err).toBeInstanceOf(ParseError);
      expect((err as ParseError).message).toContain('some trailing prose');
    }
  });

  it('includes a diagnostic snippet in the invalid-action message', () => {
    try {
      parseActionResponse('Reasoning: r\nAction:');
      throw new Error('expected a ParseError');
    } catch (err) {
      expect((err as ParseError).message).toContain('Reasoning: r');
    }
  });

  it('truncates very long responses in the error message', () => {
    const raw = 'x'.repeat(500);
    try {
      parseActionResponse(raw);
      throw new Error('expected a ParseError');
    } catch (err) {
      expect((err as ParseError).message.length).toBeLessThan(raw.length);
      expect((err as ParseError).message).toContain('…');
    }
  });
});
