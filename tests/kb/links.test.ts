import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KbError } from '../../src/kb/store.js';
import { PageStore } from '../../src/kb/store.js';
import { LinkStore } from '../../src/kb/links.js';
import { TaskStore } from '../../src/tasks/store.js';

let dir: string;
let tasks: TaskStore;
let pages: PageStore;
let links: LinkStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'state3-links-'));
  tasks = new TaskStore(dir);
  pages = new PageStore(tasks);
  links = new LinkStore(tasks);
});

afterEach(async () => {
  tasks.close();
  await rm(dir, { recursive: true, force: true });
});

const auth = { kind: 'page', id: 'auth' } as const;

function refusalOf(fn: () => unknown): { category: string; message: string } {
  try {
    fn();
  } catch (err) {
    if (err instanceof KbError) return { category: err.category, message: err.message };
    throw err;
  }
  throw new Error('expected the write to be refused');
}

async function seed(): Promise<{ taskId: string }> {
  pages.put({ id: 'auth', kind: 'feature', title: 'Auth', summary: 'Who is asking.' });
  const task = await tasks.start('Build authentication');
  return { taskId: task.meta.id };
}

describe('LinkStore.link', () => {
  it('stores a directed edge between a page and a task', async () => {
    const { taskId } = await seed();

    const edge = links.link(auth, 'documents', { kind: 'task', id: taskId });

    expect(edge).toEqual({ src: auth, rel: 'documents', dst: { kind: 'task', id: taskId } });
    expect(links.linksOf(auth)).toHaveLength(1);
  });

  it('is idempotent: linking the same triple twice stores one edge', async () => {
    const { taskId } = await seed();

    links.link(auth, 'documents', { kind: 'task', id: taskId });
    links.link(auth, 'documents', { kind: 'task', id: taskId });

    expect(links.linksOf(auth)).toHaveLength(1);
  });

  it('keeps two relations between the same pair apart', async () => {
    const { taskId } = await seed();
    const task = { kind: 'task', id: taskId };

    links.link(auth, 'documents', task);
    links.link(auth, 'implements', task);

    expect(links.linksOf(auth).map((edge) => edge.rel)).toEqual(['documents', 'implements']);
  });

  it('refuses an edge to something that is not in this root', async () => {
    pages.put({ id: 'auth', kind: 'feature', title: 'Auth', summary: 'Who is asking.' });

    const refusal = refusalOf(() => links.link(auth, 'documents', { kind: 'page', id: 'nope' }));
    expect(refusal.category).toBe('guard');
    expect(refusal.message).toContain('is not in this state root');
    expect(links.linksOf(auth)).toEqual([]);
  });

  it('refuses a self-link', async () => {
    pages.put({ id: 'auth', kind: 'feature', title: 'Auth', summary: 'Who is asking.' });

    const refusal = refusalOf(() => links.link(auth, 'see-also', auth));
    expect(refusal.category).toBe('guard');
    expect(refusal.message).toContain('cannot link to itself');
  });

  it('refuses a relation name a reader could not guess the shape of', async () => {
    const { taskId } = await seed();

    for (const rel of ['Documents', 'has space', '', 'a'.repeat(33)]) {
      const refusal = refusalOf(() => links.link(auth, rel, { kind: 'task', id: taskId }));
      expect(refusal.category, `rel "${rel}"`).toBe('schema');
    }
  });

  it('refuses an end that is neither a task nor a page', async () => {
    const refusal = refusalOf(() => links.link({ kind: 'widget', id: 'x' }, 'documents', auth));
    expect(refusal.category).toBe('schema');
    expect(refusal.message).toContain('must be a "task" or a "page"');
  });
});

describe('LinkStore.linksOf and unlink', () => {
  it('separates outgoing from incoming edges', async () => {
    const { taskId } = await seed();
    pages.put({ id: 'tokens', kind: 'feature', title: 'Tokens', summary: 'How auth is carried.' });
    const task = { kind: 'task', id: taskId };

    links.link(auth, 'documents', task);
    links.link({ kind: 'page', id: 'tokens' }, 'implements', auth);

    expect(links.linksOf(auth, 'out').map((edge) => edge.rel)).toEqual(['documents']);
    expect(links.linksOf(auth, 'in').map((edge) => edge.rel)).toEqual(['implements']);
    expect(links.linksOf(auth, 'both')).toHaveLength(2);
  });

  it('reports nothing for a node with no edges, and for a root with no database', () => {
    expect(links.linksOf(auth)).toEqual([]);
  });

  it('removes an edge once, and says so the second time', async () => {
    const { taskId } = await seed();
    const task = { kind: 'task', id: taskId };
    links.link(auth, 'documents', task);

    expect(links.unlink(auth, 'documents', task)).toBe(true);
    expect(links.unlink(auth, 'documents', task)).toBe(false);
    expect(links.linksOf(auth)).toEqual([]);
  });
});
