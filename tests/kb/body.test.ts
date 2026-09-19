import { describe, expect, it } from 'vitest';
import { MAX_BODY_EDITS, appendToBody, applyBodyEdits, parseBodyEdits } from '../../src/kb/body.js';
import type { BodyEdit } from '../../src/kb/body.js';

/** Applies one edit and returns the body, failing the test on a refusal. */
function applied(body: string, ...edits: BodyEdit[]): string {
  const result = applyBodyEdits(body, edits);
  if (!result.ok) throw new Error(`edit ${result.index + 1} was refused: ${result.message}`);
  return result.body;
}

function refusalOf(body: string, ...edits: BodyEdit[]): { index: number; message: string } {
  const result = applyBodyEdits(body, edits);
  if (result.ok) throw new Error('expected the edits to be refused');
  return { index: result.index, message: result.message };
}

describe('parseBodyEdits', () => {
  it('reads the three forms and nothing else', () => {
    const parsed = parseBodyEdits([
      { find: 'a', replace: 'b' },
      { after: '## H', insert: 'line' },
      { section: 'H', body: 'text' },
    ]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.edits).toHaveLength(3);
  });

  it('refuses anything that is not a list of edits, and says what it wanted', () => {
    const notAnArray = parseBodyEdits('body');
    expect(notAnArray.ok).toBe(false);
    if (!notAnArray.ok) expect(notAnArray.message).toContain('must be an array');

    expect(parseBodyEdits({ find: 'a' }).ok).toBe(false);
    const empty = parseBodyEdits([]);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.message).toContain('at least one edit');
  });

  it('refuses more edits than a partial write should carry', () => {
    const edits = Array.from({ length: MAX_BODY_EDITS + 1 }, () => ({ find: 'a', replace: 'b' }));
    const refused = parseBodyEdits(edits);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.message).toContain(`${MAX_BODY_EDITS + 1}`);
      expect(refused.message).toContain('op "put"');
    }
  });

  it('numbers the edit a refusal is about, so a list of them stays debuggable', () => {
    const refused = parseBodyEdits([
      { find: 'a', replace: 'b' },
      { find: 'c', replace: 'd', after: '## H' },
    ]);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.message).toContain('edit 2');
      expect(refused.message).toContain('find/replace');
    }
  });

  it('names the keys it does not know instead of dropping them', () => {
    const refused = parseBodyEdits([{ find: 'a', replace: 'b', body: 'c' }]);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toContain('"body"');
  });

  it('refuses a non-string field, an empty address, and an empty replacement', () => {
    expect(parseBodyEdits([{ find: 1, replace: 'b' }]).ok).toBe(false);
    expect(parseBodyEdits([{ find: '  ', replace: 'b' }]).ok).toBe(false);
    expect(parseBodyEdits([{ after: 'x', insert: '' }]).ok).toBe(false);
    // A section body may be empty: that is how a section is cleared.
    expect(parseBodyEdits([{ section: 'H', body: '' }]).ok).toBe(true);
  });
});

describe('a find/replace edit', () => {
  it('replaces the one place the text occurs', () => {
    const body = 'Step 1 is not written yet.\nStep 2 follows.';
    expect(applied(body, { find: 'not written yet', replace: 'implemented' })).toBe(
      'Step 1 is implemented.\nStep 2 follows.',
    );
  });

  it('refuses a match that is not there, and points at the page to copy it from', () => {
    const refusal = refusalOf('a body', { find: 'absent', replace: 'x' });
    expect(refusal.index).toBe(0);
    expect(refusal.message).toContain('matches nothing');
    expect(refusal.message).toContain('op":"get');
  });

  it('refuses a match that is not unique rather than picking one', () => {
    const refusal = refusalOf('x\nx\nx', { find: 'x', replace: 'y' });
    expect(refusal.message).toContain('matches 3 times');
    expect(refusal.message).toContain('unique');
  });

  it('applies edits in order, so a later one may address what an earlier one inserted', () => {
    const body = '# Notes\n';
    expect(
      applied(
        body,
        { after: '# Notes', insert: 'first' },
        { find: 'first', replace: 'first, then second' },
      ),
    ).toBe('# Notes\nfirst, then second\n');
  });

  it('reports which edit failed and leaves the earlier ones unapplied', () => {
    const body = 'alpha\nbeta';
    const refusal = refusalOf(
      body,
      { find: 'alpha', replace: 'ALPHA' },
      { find: 'gamma', replace: 'GAMMA' },
    );
    expect(refusal.index).toBe(1);
    expect(refusal.message).toContain('matches nothing');
    // The caller keeps the stored body when this returns a refusal; nothing was written.
    expect(body).toBe('alpha\nbeta');
  });
});

describe('an after/insert edit', () => {
  it('puts the text on the line below the anchor', () => {
    expect(applied('# Title\nfirst\n', { after: '# Title', insert: 'inserted' })).toBe(
      '# Title\ninserted\nfirst\n',
    );
  });

  it('appends below the last line when the anchor is at the end', () => {
    expect(applied('# Title\nlast', { after: 'last', insert: 'new last' })).toBe(
      '# Title\nlast\nnew last',
    );
  });

  it('inserts after the whole line, not into the middle of it', () => {
    expect(applied('- one item and more', { after: '- one item', insert: '- next' })).toBe(
      '- one item and more\n- next',
    );
  });

  it('refuses an anchor that occurs twice', () => {
    expect(refusalOf('dup\ndup', { after: 'dup', insert: 'x' }).message).toContain(
      'matches 2 times',
    );
  });
});

describe('a section/body edit', () => {
  const body = [
    '# Car combat',
    '',
    'Intro.',
    '',
    '## Damage',
    '',
    'Old damage text.',
    '',
    '### Armour',
    '',
    'armour text',
    '',
    '## Ammo',
    '',
    'ammo text',
    '',
  ].join('\n');

  it('replaces a section up to the next heading of the same level, subsections included', () => {
    const result = applied(body, { section: 'Damage', body: 'New damage text.' });
    expect(result).toContain('## Damage\nNew damage text.\n\n## Ammo');
    expect(result).not.toContain('Old damage text.');
    expect(result).not.toContain('Armour');
    expect(result).toContain('Intro.');
    expect(result).toContain('ammo text');
  });

  it('accepts the heading with or without its hashes', () => {
    expect(applied(body, { section: '## Ammo', body: 'new ammo' })).toContain('## Ammo\nnew ammo');
  });

  it('replaces the last section without inventing a trailing blank one', () => {
    expect(applied(body, { section: 'Ammo', body: 'reloaded' }).endsWith('## Ammo\nreloaded')).toBe(
      true,
    );
  });

  it('clears a section when the new body is empty', () => {
    const cleared = applied(body, { section: 'Ammo', body: '' });
    expect(cleared).not.toContain('ammo text');
    expect(cleared).toContain('## Ammo');
  });

  it('refuses a heading that is not there, and lists the ones that are', () => {
    const refusal = refusalOf(body, { section: 'Handling', body: 'x' });
    expect(refusal.message).toContain('matches no heading');
    expect(refusal.message).toContain('"Damage"');
    expect(refusal.message).toContain('"Ammo"');
  });

  it('refuses an ambiguous heading instead of editing the first one', () => {
    const twice = '# A\n\n## Notes\none\n\n## Notes\ntwo\n';
    expect(refusalOf(twice, { section: 'Notes', body: 'x' }).message).toContain(
      'matches 2 headings',
    );
  });

  it('says so when the body has no headings at all', () => {
    const refusal = refusalOf('plain text only', { section: 'Anything', body: 'x' });
    expect(refusal.message).toContain('no headings');
  });
});

describe('appendToBody', () => {
  it('separates the addition from what was there by one blank line', () => {
    expect(appendToBody('# Notes\n\nfirst entry\n', 'second entry')).toBe(
      '# Notes\n\nfirst entry\n\nsecond entry',
    );
  });

  it('takes the text as it is when the body is empty', () => {
    expect(appendToBody('', 'first entry')).toBe('first entry');
    expect(appendToBody('   \n', 'first entry')).toBe('first entry');
  });

  it('drops the leading blank lines of the addition, which would only pad the page', () => {
    expect(appendToBody('body', '\n\nadded')).toBe('body\n\nadded');
  });
});
