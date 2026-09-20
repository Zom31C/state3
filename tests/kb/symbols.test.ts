import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SYMBOLS_LIMIT, SYMBOL_MAX_CHARS } from '../../src/kb/schema.js';
import { symbolFile } from '../../src/kb/sources.js';
import { KbError, PageStore } from '../../src/kb/store.js';
import { renderPage } from '../../src/mcp/kb-tools.js';
import { TaskStore } from '../../src/tasks/store.js';

/**
 * The symbol list of a page.
 *
 * It exists because a body holds symbols in prose: "who builds the bridges" was answerable
 * only by reading the page that happened to mention it, and a page nobody thought to open is
 * a question answered by grep instead. These tests cover the three things that make the field
 * worth its column — that it survives a write, that a search matches it, and that a match
 * names the file.
 */
let dir: string;
let tasks: TaskStore;
let pages: PageStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'skillstate-symbols-'));
  tasks = new TaskStore(dir);
  pages = new PageStore(tasks);
});

afterEach(async () => {
  tasks.close();
  await rm(dir, { recursive: true, force: true });
});

const roadPage = {
  id: 'road-network',
  kind: 'feature' as const,
  title: 'Road network',
  summary: 'How the roads are laid out.',
};

const SYMBOLS = [
  'RoadMask — scripts/RoadNetwork.cs',
  'BuildBridges — scripts/RoadNetwork.cs',
  'Terrain.HeightAt — scripts/Terrain.cs',
];

const ids = (hits: { kind: string; id: string }[]): string[] =>
  hits.map((hit) => `${hit.kind}:${hit.id}`);

function refusalOf(fn: () => unknown): { category: string; message: string } {
  try {
    fn();
  } catch (err) {
    if (err instanceof KbError) return { category: err.category, message: err.message };
    throw err;
  }
  throw new Error('expected the write to be refused');
}

describe('symbolFile', () => {
  it('reads the path half of a symbol line', () => {
    expect(symbolFile('RoadMask — scripts/RoadNetwork.cs')).toBe('scripts/RoadNetwork.cs');
  });

  it('is null for a line that names no file, which is a name worth indexing anyway', () => {
    expect(symbolFile('RoadMask')).toBeNull();
  });
});

describe('PageStore symbols', () => {
  it('stores the list and reads it back as a list', () => {
    const stored = pages.put({ ...roadPage, symbols: SYMBOLS });

    expect(stored.symbols).toEqual(SYMBOLS);
    expect(pages.get('road-network')?.symbols).toEqual(SYMBOLS);
  });

  it('keeps the list when an update omits it, so a body edit costs nothing else', () => {
    pages.put({ ...roadPage, symbols: SYMBOLS });

    const updated = pages.put({ id: 'road-network', body: 'A rewritten body.' });

    expect(updated.symbols).toEqual(SYMBOLS);
    expect(updated.body).toBe('A rewritten body.');
  });

  it('replaces the list when an update sends one, including with an empty list', () => {
    pages.put({ ...roadPage, symbols: SYMBOLS });

    expect(pages.put({ id: 'road-network', symbols: ['Only — a.cs'] }).symbols).toEqual([
      'Only — a.cs',
    ]);
    expect(pages.put({ id: 'road-network', symbols: [] }).symbols).toEqual([]);
  });

  it('is empty for a page written without any', () => {
    expect(pages.put({ ...roadPage }).symbols).toEqual([]);
  });

  it('refuses more symbols than a page is an index of', () => {
    const tooMany = Array.from({ length: SYMBOLS_LIMIT + 1 }, (_, index) => `S${index} — a.cs`);

    const refusal = refusalOf(() => pages.put({ ...roadPage, symbols: tooMany }));

    expect(refusal.category).toBe('schema');
    expect(refusal.message).toContain('symbols');
  });

  it('refuses a line long enough to be prose, which is the body job', () => {
    const refusal = refusalOf(() =>
      pages.put({ ...roadPage, symbols: ['x'.repeat(SYMBOL_MAX_CHARS + 1)] }),
    );

    expect(refusal.category).toBe('schema');
  });

  it('refuses an entry that is not a line of text', () => {
    expect(refusalOf(() => pages.put({ ...roadPage, symbols: [7] })).category).toBe(
      'type-coercion',
    );
  });
});

describe('search over symbols', () => {
  it('finds a page by a symbol name, and the snippet names the file', () => {
    pages.put({ ...roadPage, symbols: SYMBOLS, body: 'Roads are laid out over the terrain.' });

    const hits = pages.search('BuildBridges');

    expect(ids(hits)).toEqual(['page:road-network']);
    expect(hits[0]?.snippet).toContain('[BuildBridges]');
    expect(hits[0]?.snippet).toContain('scripts/RoadNetwork.cs');
  });

  it('finds a fragment of an identifier, which the index cannot tokenize but a symbol can hold', () => {
    pages.put({ ...roadPage, symbols: SYMBOLS, body: 'Roads only.' });

    // "RoadNet" is part of one token to the tokenizer, so FTS misses it and the substring
    // pass answers — which now reads the symbol column too.
    const hits = pages.search('RoadNet');

    expect(ids(hits)).toEqual(['page:road-network']);
    expect(hits[0]?.snippet).toContain('RoadNetwork.cs');
  });

  it('ranks a symbol above the same word mentioned in passing in a long body', () => {
    const filler = 'the road network is described in prose here. '.repeat(40);
    pages.put({
      id: 'prose',
      kind: 'note',
      title: 'Notes about roads',
      summary: 'Long notes.',
      body: `${filler} RoadMask is mentioned once. ${filler}`,
    });
    pages.put({ ...roadPage, symbols: SYMBOLS, body: 'Layout.' });

    expect(ids(pages.search('RoadMask'))[0]).toBe('page:road-network');
  });

  it('re-indexes the symbols when a page is rewritten, so a removed one stops matching', () => {
    pages.put({ ...roadPage, symbols: SYMBOLS });
    expect(ids(pages.search('BuildBridges'))).toEqual(['page:road-network']);

    pages.put({ id: 'road-network', symbols: ['RoadMask — scripts/RoadNetwork.cs'] });

    expect(pages.search('BuildBridges')).toEqual([]);
    expect(ids(pages.search('RoadMask'))).toEqual(['page:road-network']);
  });

  it('drops the symbols of a deleted page with the rest of it', () => {
    pages.put({ ...roadPage, symbols: SYMBOLS });

    pages.delete('road-network');

    expect(pages.search('RoadMask')).toEqual([]);
  });
});

describe('renderPage', () => {
  it('lists the symbols above the links and the body, so a reader can scan them', () => {
    const stored = pages.put({ ...roadPage, symbols: SYMBOLS, body: 'The layout.' });

    const text = renderPage(stored, []);

    expect(text).toContain('symbols:');
    expect(text).toContain('  RoadMask — scripts/RoadNetwork.cs');
    expect(text).toContain('  Terrain.HeightAt — scripts/Terrain.cs');
    expect(text.indexOf('symbols:')).toBeLessThan(text.indexOf('links:'));
    expect(text.indexOf('links:')).toBeLessThan(text.indexOf('The layout.'));
  });

  it('prints no symbols block for a page that has none', () => {
    expect(renderPage(pages.put({ ...roadPage }), [])).not.toContain('symbols:');
  });
});
