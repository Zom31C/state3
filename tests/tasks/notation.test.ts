import { describe, expect, it } from 'vitest';
import {
  COMPACT_NOTATION_INSTRUCTIONS,
  DEFAULT_NOTATION,
  isNotation,
  NOTATIONS,
  notationInstructions,
  notationReminder,
} from '../../src/tasks/notation.js';
import type { Notation } from '../../src/tasks/notation.js';

describe('NOTATIONS', () => {
  it('offers plain and compact, and defaults to plain prose', () => {
    expect(NOTATIONS).toEqual(['plain', 'compact']);
    expect(DEFAULT_NOTATION).toBe('plain');
    expect(NOTATIONS).toContain(DEFAULT_NOTATION);
  });
});

describe('isNotation', () => {
  it('accepts exactly the declared notations', () => {
    for (const notation of NOTATIONS) {
      expect(isNotation(notation)).toBe(true);
    }
  });

  it('rejects anything else, including near misses and non-strings', () => {
    for (const value of [
      'haiku',
      'PLAIN',
      'Compact',
      '',
      ' ',
      'compact ',
      undefined,
      null,
      1,
      {},
    ]) {
      expect(isNotation(value)).toBe(false);
    }
  });

  it('narrows the type so the value can be used as a Notation', () => {
    const value: unknown = 'compact';
    if (isNotation(value)) {
      const notation: Notation = value;
      expect(notation).toBe('compact');
    } else {
      expect.unreachable('compact is a notation');
    }
  });
});

describe('notationInstructions', () => {
  it('adds nothing for plain prose', () => {
    expect(notationInstructions('plain')).toBe('');
  });

  it('returns the compact rules for compact notation', () => {
    expect(notationInstructions('compact')).toBe(COMPACT_NOTATION_INSTRUCTIONS);
    expect(COMPACT_NOTATION_INSTRUCTIONS.trim().length).toBeGreaterThan(0);
  });

  it('heads the compact appendix with the notation name', () => {
    expect(COMPACT_NOTATION_INSTRUCTIONS.startsWith('## Notation: compact')).toBe(true);
  });

  it('states the compact rules: pseudocode, symbols, one line, verbatim identifiers', () => {
    const text = notationInstructions('compact');
    expect(text).toContain('compressed pseudocode');
    expect(text).toContain('Drop articles and filler');
    expect(text).toContain('->');
    expect(text).toContain('One entry = one line');
    expect(text).toContain('Verbatim, never compressed');
    expect(text).toContain('file paths, identifiers, commands');
    expect(text).toContain('Example — good');
    expect(text).toContain('Example — bad');
  });

  it('keeps the rule that a fact must never be compressed away', () => {
    expect(notationInstructions('compact')).toContain('Never compress away a fact');
  });
});

describe('notationReminder', () => {
  it('is empty for plain notation', () => {
    expect(notationReminder('plain')).toBe('');
  });

  it('is one line for compact notation', () => {
    const reminder = notationReminder('compact');
    expect(reminder.trim().length).toBeGreaterThan(0);
    expect(reminder).not.toContain('\n');
  });

  it('names the notation and its symbols', () => {
    const reminder = notationReminder('compact');
    expect(reminder).toContain('compact notation');
    expect(reminder).toContain('->');
    expect(reminder).toContain('pseudocode');
    expect(reminder).toContain('verbatim');
  });

  it('is far shorter than the appendix it stands in for', () => {
    expect(notationReminder('compact').length).toBeLessThan(notationInstructions('compact').length);
  });
});
