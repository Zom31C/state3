import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { STATE_DB_FILENAME } from '../../src/db/database.js';
import { KbError, PageStore } from '../../src/kb/store.js';
import { SUMMARY_MAX_CHARS } from '../../src/kb/schema.js';
import { TaskStore } from '../../src/tasks/store.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir: string;
let tasks: TaskStore;
let pages: PageStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'skillstate-kb-'));
  tasks = new TaskStore(dir);
  pages = new PageStore(tasks);
});

afterEach(async () => {
  // The database file cannot be deleted on Windows while a connection holds it.
  tasks.close();
  await rm(dir, { recursive: true, force: true });
});

const projectPage = {
  id: 'project',
  kind: 'project',
  title: 'skillState',
  summary: 'External validated task state for long agent work.',
};

/** Refusals are the interesting half: they carry a category the tool layer turns into a hint. */
function refusalOf(fn: () => unknown): { category: string; message: string } {
  try {
    fn();
  } catch (err) {
    if (err instanceof KbError) return { category: err.category, message: err.message };
    throw err;
  }
  throw new Error('expected the write to be refused');
}

function searchRowsFor(id: string): { title: string; summary: string; body: string }[] {
  return tasks
    .database()
    .prepare('SELECT title, summary, body FROM search WHERE ref_kind = ? AND ref_id = ?')
    .all('page', id) as { title: string; summary: string; body: string }[];
}

describe('PageStore reads', () => {
  it('creates no database: an empty project and a wrong root must stay distinguishable', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'skillstate-kb-empty-'));
    const owner = new TaskStore(empty);
    try {
      const reader = new PageStore(owner);
      expect(reader.list()).toEqual([]);
      expect(reader.count()).toBe(0);
      expect(reader.get('project')).toBeNull();
      expect(await readdir(empty)).toEqual([]);
    } finally {
      owner.close();
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('returns null for a page that is not there', () => {
    pages.put(projectPage);
    expect(pages.get('nope')).toBeNull();
  });
});

describe('PageStore.put', () => {
  it('stores a page and reads it back whole', () => {
    const stored = pages.put({ ...projectPage, body: 'The runtime lives in src/.', pin: true });

    expect(stored.id).toBe('project');
    expect(stored.kind).toBe('project');
    expect(stored.pin).toBe(true);
    expect(stored.status).toBe('current');
    expect(stored.parent).toBeNull();
    expect(pages.get('project')).toEqual(stored);
    expect(pages.count()).toBe(1);
  });

  it('refuses to create a page without the fields the brief needs', () => {
    const refusal = refusalOf(() => pages.put({ id: 'auth', kind: 'feature' }));
    expect(refusal.category).toBe('schema');
    expect(refusal.message).toContain('title');
    expect(refusal.message).toContain('summary');
    expect(pages.count()).toBe(0);
  });

  it('updates in place: an omitted field keeps its value, and only updated_at moves', async () => {
    const created = pages.put({ ...projectPage, body: 'first' });
    await delay(10);

    const updated = pages.put({ id: 'project', body: 'second' });

    expect(updated.title).toBe(projectPage.title);
    expect(updated.summary).toBe(projectPage.summary);
    expect(updated.kind).toBe('project');
    expect(updated.body).toBe('second');
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt > created.updatedAt).toBe(true);
    expect(pages.count()).toBe(1);
  });

  it('tells "clear the parent" from "leave the parent alone"', () => {
    pages.put(projectPage);
    pages.put({
      id: 'auth',
      kind: 'feature',
      title: 'Auth',
      summary: 'Who is asking.',
      parent: 'project',
    });

    expect(pages.put({ id: 'auth', body: 'changed' }).parent).toBe('project');
    expect(pages.put({ id: 'auth', parent: null }).parent).toBeNull();
  });

  it('reports a bad shape with the shared rejection vocabulary', () => {
    expect(refusalOf(() => pages.put({ id: 'p', titel: 'x' })).category).toBe('unknown-key');
    expect(refusalOf(() => pages.put({ id: 'p', pin: 'yes' })).category).toBe('type-coercion');
    expect(
      refusalOf(() => pages.put({ id: 'p', summary: 'x'.repeat(SUMMARY_MAX_CHARS + 1) })).category,
    ).toBe('schema');
  });

  it('refuses a singleton kind under another id, and a reserved id under another kind', () => {
    expect(refusalOf(() => pages.put({ ...projectPage, id: 'overview' })).category).toBe('guard');

    const refusal = refusalOf(() =>
      pages.put({ id: 'project', kind: 'feature', title: 'F', summary: 'S' }),
    );
    expect(refusal.category).toBe('guard');
    expect(refusal.message).toContain('reserved for the singleton');
  });

  it('refuses a parent that does not exist, and a parent that would close a cycle', () => {
    pages.put(projectPage);
    pages.put({ id: 'auth', kind: 'feature', title: 'Auth', summary: 'Who is asking.' });
    pages.put({
      id: 'tokens',
      kind: 'feature',
      title: 'Tokens',
      summary: 'How auth is carried.',
      parent: 'auth',
    });

    expect(
      refusalOf(() =>
        pages.put({ id: 'orphan', kind: 'note', title: 'O', summary: 'S', parent: 'missing' }),
      ).message,
    ).toContain('does not exist');
    // auth -> tokens already; making tokens auth's parent would loop.
    expect(refusalOf(() => pages.put({ id: 'auth', parent: 'tokens' })).message).toContain(
      'its own ancestor',
    );
    expect(pages.get('auth')?.parent).toBeNull();
  });

  it('refuses an update that would rewrite a kind this build does not know', () => {
    tasks
      .database()
      .prepare(
        `INSERT INTO page (id, kind, title, summary, body, status, pin, created_at, updated_at)
         VALUES ('alien', 'hologram', 'Alien', 'S', '', 'current', 0, '2026-09-11T10:00:00.000Z', '2026-09-11T10:00:00.000Z')`,
      )
      .run();

    const refusal = refusalOf(() => pages.put({ id: 'alien', body: 'rewritten' }));
    expect(refusal.category).toBe('schema');
    expect(refusal.message).toContain('hologram');
  });
});

describe('PageStore.list', () => {
  it('leaves bodies out, which is what makes the listing cheap enough to inject', () => {
    pages.put({ ...projectPage, body: 'x'.repeat(5000) });

    const [summary] = pages.list();
    expect(summary).toBeDefined();
    expect('body' in (summary as object)).toBe(false);
    expect(summary?.summary).toBe(projectPage.summary);
  });

  it('puts pinned pages first, then the most recently updated', async () => {
    pages.put({ id: 'old', kind: 'note', title: 'Old', summary: 'S' });
    await delay(10);
    pages.put({ id: 'new', kind: 'note', title: 'New', summary: 'S' });
    await delay(10);
    pages.put({ id: 'pinned', kind: 'note', title: 'Pinned', summary: 'S', pin: true });

    expect(pages.list().map((page) => page.id)).toEqual(['pinned', 'new', 'old']);
  });

  it('filters by kind, by status and by parent', () => {
    pages.put(projectPage);
    pages.put({ id: 'auth', kind: 'feature', title: 'Auth', summary: 'S', parent: 'project' });
    pages.put({
      id: 'old-decision',
      kind: 'decision',
      title: 'D',
      summary: 'S',
      status: 'archived',
    });

    expect(pages.list({ kind: 'feature' }).map((p) => p.id)).toEqual(['auth']);
    expect(
      pages
        .list({ statuses: ['current', 'stale'] })
        .map((p) => p.id)
        .sort(),
    ).toEqual(['auth', 'project']);
    expect(pages.list({ parent: 'project' }).map((p) => p.id)).toEqual(['auth']);
    expect(
      pages
        .list({ parent: null })
        .map((p) => p.id)
        .sort(),
    ).toEqual(['old-decision', 'project']);
  });

  it('skips a row whose kind this build does not know instead of failing the list', () => {
    pages.put(projectPage);
    tasks
      .database()
      .prepare(
        `INSERT INTO page (id, kind, title, summary, body, status, pin, created_at, updated_at)
         VALUES ('alien', 'hologram', 'Alien', 'S', '', 'current', 0, '2026-09-11T10:00:00.000Z', '2026-09-11T10:00:00.000Z')`,
      )
      .run();

    expect(pages.list().map((page) => page.id)).toEqual(['project']);
    expect(refusalOf(() => pages.get('alien')).message).toContain('hologram');
  });
});

describe('the search index', () => {
  it('indexes a page on insert, re-indexes it on update, and drops it on delete', () => {
    pages.put({ ...projectPage, body: 'The runtime lives in src/.' });
    expect(searchRowsFor('project')).toEqual([
      {
        title: projectPage.title,
        summary: projectPage.summary,
        body: 'The runtime lives in src/.',
      },
    ]);

    pages.put({ id: 'project', body: 'Rewritten body.' });
    expect(searchRowsFor('project')).toEqual([
      { title: projectPage.title, summary: projectPage.summary, body: 'Rewritten body.' },
    ]);

    pages.delete('project');
    expect(searchRowsFor('project')).toEqual([]);
  });

  it('finds a page by a Russian word in its body, because the KB is written in the user language', () => {
    pages.put({
      id: 'auth',
      kind: 'feature',
      title: 'Авторизация',
      summary: 'Как сессия подтверждает, кто она.',
      body: 'Токены проверяются в src/auth.ts.',
    });

    const hits = tasks
      .database()
      .prepare(`SELECT ref_id FROM search WHERE search MATCH ?`)
      .all('проверяются') as { ref_id: string }[];
    expect(hits.map((hit) => hit.ref_id)).toEqual(['auth']);
  });

  it('keeps the index in step with the tables, which is what doctor checks', async () => {
    await tasks.start('Build the knowledge base');
    pages.put(projectPage);
    pages.put({ id: 'auth', kind: 'feature', title: 'Auth', summary: 'Who is asking.' });

    const indexed = tasks.database().prepare('SELECT count(*) AS n FROM search').get() as {
      n: number;
    };
    // One row per task and per page: the triggers keep the two tables and the index agreeing.
    expect(indexed.n).toBe(3);
  });
});

describe('PageStore.delete', () => {
  it('reports whether there was anything to delete', () => {
    pages.put(projectPage);
    expect(pages.delete('project')).toBe(true);
    expect(pages.delete('project')).toBe(false);
  });

  it('keeps children, promoting them to root pages', () => {
    pages.put(projectPage);
    pages.put({ id: 'auth', kind: 'feature', title: 'Auth', summary: 'S', parent: 'project' });

    pages.delete('project');

    expect(pages.get('auth')?.parent).toBeNull();
  });

  it('removes the edges that pointed at the page, so no dangling link is left behind', () => {
    pages.put(projectPage);
    tasks
      .database()
      .prepare('INSERT INTO link (src_kind, src_id, rel, dst_kind, dst_id) VALUES (?, ?, ?, ?, ?)')
      .run('task', 'task-1', 'documents', 'page', 'project');
    tasks
      .database()
      .prepare('INSERT INTO link (src_kind, src_id, rel, dst_kind, dst_id) VALUES (?, ?, ?, ?, ?)')
      .run('page', 'project', 'mentions', 'task', 'task-1');

    pages.delete('project');

    const left = tasks.database().prepare('SELECT count(*) AS n FROM link').get() as { n: number };
    expect(left.n).toBe(0);
  });
});

describe('the shared connection', () => {
  it('keeps pages and tasks in the one database file', async () => {
    await tasks.start('Build the knowledge base');
    pages.put(projectPage);

    const names = await readdir(dir);
    expect(names).toContain(STATE_DB_FILENAME);
    expect(names.filter((name) => name.endsWith('.json'))).toEqual([]);

    const counted = tasks
      .database()
      .prepare('SELECT (SELECT count(*) FROM task) AS t, (SELECT count(*) FROM page) AS p')
      .get() as { t: number; p: number };
    expect(counted).toEqual({ t: 1, p: 1 });
  });
});
