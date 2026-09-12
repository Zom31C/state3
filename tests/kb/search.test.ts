import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PageStore } from '../../src/kb/store.js';
import { ftsExpression } from '../../src/kb/search.js';
import { TaskStore } from '../../src/tasks/store.js';

let dir: string;
let tasks: TaskStore;
let pages: PageStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'skillstate-search-'));
  tasks = new TaskStore(dir);
  pages = new PageStore(tasks);
});

afterEach(async () => {
  tasks.close();
  await rm(dir, { recursive: true, force: true });
});

const ids = (hits: { kind: string; id: string }[]): string[] =>
  hits.map((hit) => `${hit.kind}:${hit.id}`);

describe('PageStore.search', () => {
  it('finds a page by a word in its body and marks the match in the snippet', () => {
    pages.put({
      id: 'auth',
      kind: 'feature',
      title: 'Authentication',
      summary: 'Who is asking.',
      body: 'Tokens are verified by the middleware before a handler runs.',
    });

    const hits = pages.search('middleware');

    expect(ids(hits)).toEqual(['page:auth']);
    expect(hits[0]?.snippet).toContain('[middleware]');
  });

  it('finds a page by a word that only appears in its title', () => {
    pages.put({ id: 'auth', kind: 'feature', title: 'Authentication', summary: 'Who is asking.' });

    const hits = pages.search('Authentication');

    expect(ids(hits)).toEqual(['page:auth']);
    expect(hits[0]?.snippet).toContain('[Authentication]');
  });

  it('searches task states alongside pages, so "which task decided this" is answerable', async () => {
    pages.put({ id: 'auth', kind: 'feature', title: 'Authentication', summary: 'Who is asking.' });
    const task = await tasks.start('Build authentication');
    await tasks.patch({ decisions: ['use rotating refresh tokens'] }, task.meta.id);

    expect(ids(pages.search('authentication'))).toContain('page:auth');

    const decisionHits = pages.search('rotating');
    expect(ids(decisionHits)).toEqual([`task:${task.meta.id}`]);
    expect(decisionHits[0]?.snippet).toContain('[rotating]');
  });

  it('requires every word, so a hit really is about all of them', () => {
    pages.put({ id: 'auth', kind: 'feature', title: 'Auth', summary: 'S', body: 'tokens only' });
    pages.put({ id: 'ui', kind: 'feature', title: 'UI', summary: 'S', body: 'widgets only' });

    expect(pages.search('tokens widgets')).toEqual([]);
    expect(ids(pages.search('tokens'))).toEqual(['page:auth']);
  });

  it('finds a substring of an identifier, which the tokenizer alone would hide', () => {
    pages.put({
      id: 'patching',
      kind: 'decision',
      title: 'Path patches',
      summary: 'Why plan[1].status works.',
      body: 'The expander is expandPathPatch in src/core/state.ts.',
    });

    expect(ids(pages.search('PathPatch'))).toEqual(['page:patching']);
  });

  it('answers a query full of FTS syntax without throwing', () => {
    pages.put({
      id: 'patching',
      kind: 'note',
      title: 'Patching',
      summary: 'S',
      body: 'Append a plan item with "plan[+]", delete a key with NOT null.',
    });

    for (const query of ['plan[+]', '"quoted"', 'NOT null', 'a AND (b OR c)', '*']) {
      expect(() => pages.search(query), `query ${query}`).not.toThrow();
    }
    expect(ids(pages.search('plan[+]'))).toEqual(['page:patching']);
  });

  it('finds Russian text, because the knowledge base is written in the user language', () => {
    pages.put({
      id: 'auth',
      kind: 'feature',
      title: 'Авторизация',
      summary: 'Как сессия подтверждает, кто она.',
      body: 'Токены проверяются в промежуточном слое.',
    });

    expect(ids(pages.search('проверяются'))).toEqual(['page:auth']);
    expect(ids(pages.search('Авторизация'))).toEqual(['page:auth']);
  });

  it('restricts to one kind when asked', async () => {
    pages.put({ id: 'auth', kind: 'feature', title: 'Auth', summary: 'S', body: 'shared word' });
    await tasks.start('a task with the same shared word');

    expect(ids(pages.search('shared', { kind: 'page' }))).toEqual(['page:auth']);
    expect(ids(pages.search('shared', { kind: 'task' }))).toHaveLength(1);
    expect(pages.search('shared')).toHaveLength(2);
  });

  it('honours the limit', () => {
    for (let index = 0; index < 5; index++) {
      pages.put({
        id: `note-${index}`,
        kind: 'note',
        title: `Note ${index}`,
        summary: 'S',
        body: 'the same word everywhere',
      });
    }

    expect(pages.search('word', { limit: 2 })).toHaveLength(2);
    expect(pages.search('word')).toHaveLength(5);
  });

  it('answers an empty query and an empty project with nothing, not with an error', () => {
    expect(pages.search('   ')).toEqual([]);
    expect(pages.search('anything')).toEqual([]);
  });

  it('ranks a title match above a body match', () => {
    pages.put({
      id: 'in-title',
      kind: 'note',
      title: 'WAL folding',
      summary: 'S',
      body: 'unrelated',
    });
    pages.put({
      id: 'in-body',
      kind: 'note',
      title: 'Something else',
      summary: 'S',
      body: 'a long body that happens to mention WAL folding near the end',
    });

    expect(ids(pages.search('WAL folding'))).toEqual(['page:in-title', 'page:in-body']);
  });
});

describe('ftsExpression', () => {
  it('quotes every word, so model-typed text cannot become FTS syntax', () => {
    expect(ftsExpression('plan[+] AND "x"')).toBe('"plan[+]" "AND" """x"""');
    expect(ftsExpression('  spaced   out ')).toBe('"spaced" "out"');
    expect(ftsExpression('')).toBe('');
  });
});
