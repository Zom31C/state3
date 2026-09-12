import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { STATE_DB_FILENAME } from '../../src/db/database.js';
import { PageStore } from '../../src/kb/store.js';
import { readInjection } from '../../src/tasks/inject.js';
import type { Injection } from '../../src/tasks/inject.js';
import { TaskStore } from '../../src/tasks/store.js';

let dir: string;
let store: TaskStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'skillstate-inject-'));
  store = new TaskStore(dir);
});

afterEach(async () => {
  // The database file cannot be deleted on Windows while a connection holds it.
  store.close();
  await rm(dir, { recursive: true, force: true });
});

/** Σ of a row written past every validation, the way a foreign build or a hand edit leaves it. */
function stateJson(status: string, goal: string, risk = 'safe'): string {
  return JSON.stringify({
    goal,
    status,
    plan: [{ id: '1', task: 'step one', status: 'in_progress', notes: '' }],
    artifacts: {},
    verifications: [],
    decisions: [],
    blockers: [],
    next: { action: 'continue', risk },
  });
}

/**
 * Inserts a row with an explicit status and timestamp. Ordering is what pickCandidate runs
 * on, so the tests set it rather than relying on two `start` calls landing a millisecond apart.
 */
function forceRow(
  id: string,
  options: { status?: string; skill?: string; state?: string; updatedAt?: string } = {},
): void {
  const status = options.status ?? 'active';
  store
    .database()
    .prepare(
      `INSERT INTO task (id, skill, notation, status, goal, state, progress_done, progress_total, created_at, updated_at)
       VALUES (?, ?, 'plain', ?, ?, ?, 0, 0, '2026-09-07T18:30:59.046Z', ?)`,
    )
    .run(
      id,
      options.skill ?? 'dev-task',
      status,
      `goal of ${id}`,
      options.state ?? stateJson(status, `goal of ${id}`),
      options.updatedAt ?? '2026-09-07T22:13:55.832Z',
    );
}

/** Σ out of an injection, failing the test when this root had nothing to inject. */
function taskOf(injection: Injection): string {
  if (injection.kind !== 'context' || injection.task === null) {
    throw new Error(`expected an injection carrying Σ, got ${JSON.stringify(injection)}`);
  }
  return injection.task;
}

/** The brief out of an injection: null is a legitimate answer, a missing injection is not. */
function briefOf(injection: Injection): string | null {
  if (injection.kind !== 'context') {
    throw new Error(`expected an injection, got ${JSON.stringify(injection)}`);
  }
  return injection.brief;
}

/** One page, so the root has a knowledge base to brief. */
function writePage(store: TaskStore, summary: string): void {
  new PageStore(store).put({
    id: 'project',
    kind: 'project',
    title: 'skillState',
    summary,
    body: 'A body the brief must not carry.',
  });
}

describe('readInjection', () => {
  it('reports a root with no database, and creates nothing', async () => {
    expect(readInjection(dir)).toEqual({ kind: 'none' });
    expect(await readdir(dir)).toEqual([]);
  });

  it('reports a root that does not exist, without creating it', async () => {
    const missing = path.join(dir, 'nope');

    expect(readInjection(missing)).toEqual({ kind: 'none' });
    expect(await readdir(dir)).toEqual([]);
  });

  it('renders the active task exactly as the tools do', async () => {
    const task = await store.start('Ship the adapter');
    store.close();

    const head = taskOf(readInjection(dir));

    expect(head.split('\n')[0]).toBe(`Task ${task.meta.id} [dev-task] (active):`);
    expect(head).toContain('"goal":"Ship the adapter"');
  });

  it('prefers an active task over a blocked one updated later', () => {
    forceRow('task-blocked', { status: 'blocked', updatedAt: '2026-09-08T09:00:00.000Z' });
    forceRow('task-active', { status: 'active', updatedAt: '2026-09-07T09:00:00.000Z' });
    store.close();

    expect(taskOf(readInjection(dir))).toContain('task-active');
  });

  it('injects a blocked task when nothing is active, because a blocked task is still open', () => {
    forceRow('task-done', { status: 'done', updatedAt: '2026-09-09T09:00:00.000Z' });
    forceRow('task-blocked', { status: 'blocked', updatedAt: '2026-09-08T09:00:00.000Z' });
    store.close();

    const head = taskOf(readInjection(dir));
    expect(head).toContain('task-blocked');
    expect(head).toContain('(blocked)');
  });

  it('reports idle when every task is done, which is not the same as no database', () => {
    forceRow('task-1', { status: 'done' });
    store.close();

    expect(readInjection(dir)).toEqual({ kind: 'idle' });
  });

  it('leaves an at-rest root a single file: no WAL siblings after reading', async () => {
    await store.start('Ship the adapter');
    store.close();
    expect(await readdir(dir)).toEqual([STATE_DB_FILENAME]);

    readInjection(dir);
    readInjection(dir, { brief: true });

    // A read-only connection cannot delete these on close, and the hook runs on every prompt:
    // it would otherwise litter the project with state.db-shm and state.db-wal.
    expect(await readdir(dir)).toEqual([STATE_DB_FILENAME]);
  });

  it('reports a database that is not a database, instead of throwing', async () => {
    store.close();
    await writeFile(path.join(dir, STATE_DB_FILENAME), 'this is not a database\n', 'utf8');

    const injection = readInjection(dir);

    expect(injection.kind).toBe('unreadable');
    if (injection.kind !== 'unreadable') throw new Error('unreachable');
    expect(injection.reason.length).toBeGreaterThan(0);
  });

  it('injects a task whose skill this runtime does not have', () => {
    // A supervising session does not hold its worker's skill. Dropping that Σ would hide the
    // very state the session is resuming; the tools still refuse to patch what they cannot read.
    forceRow('task-foreign', { skill: 'a-skill-from-somewhere-else' });
    store.close();

    expect(taskOf(readInjection(dir))).toContain('[a-skill-from-somewhere-else]');
  });

  it('reports a hand-damaged Σ as unreadable, naming the task', () => {
    forceRow('task-broken', { state: '{not json' });
    store.close();

    const injection = readInjection(dir);

    expect(injection.kind).toBe('unreadable');
    if (injection.kind !== 'unreadable') throw new Error('unreachable');
    expect(injection.reason).toContain('task-broken');
  });
});

describe('readInjection with a brief', () => {
  it('adds the knowledge base when asked for, and leaves it out otherwise', async () => {
    await store.start('Ship the adapter');
    writePage(store, 'External task state for long agent work.');
    store.close();

    const plain = readInjection(dir);
    expect(plain.kind).toBe('context');
    if (plain.kind !== 'context') throw new Error('unreachable');
    expect(plain.brief).toBeNull();

    const brief = briefOf(readInjection(dir, { brief: true }));
    expect(brief).toContain('# Project brief');
    expect(brief).toContain('- project: External task state for long agent work.');
    expect(brief).not.toContain('A body the brief must not carry.');
  });

  it('briefs a project whose tasks are all done, because pages outlive the task', () => {
    forceRow('task-1', { status: 'done' });
    writePage(store, 'What this project is.');
    store.close();

    const injection = readInjection(dir, { brief: true });

    expect(injection.kind).toBe('context');
    if (injection.kind !== 'context') throw new Error('unreachable');
    expect(injection.task).toBeNull();
    expect(injection.brief).toContain('- project: What this project is.');
  });

  it('carries Σ and the brief together, which is what a session start injects', async () => {
    const task = await store.start('Ship the adapter');
    writePage(store, 'What this project is.');
    store.close();

    const injection = readInjection(dir, { brief: true });

    expect(injection.kind).toBe('context');
    if (injection.kind !== 'context') throw new Error('unreachable');
    expect(injection.task).toContain(task.meta.id);
    expect(injection.brief).toContain('- project: What this project is.');
  });

  it('stays idle for a project with neither an open task nor a page', () => {
    forceRow('task-1', { status: 'done' });
    store.close();

    // An empty knowledge base is not briefed: the tools say what to write first, and a hook
    // would otherwise repeat that at the start of every session of every such project.
    expect(readInjection(dir, { brief: true })).toEqual({ kind: 'idle' });
  });

  it('reports a damaged database as unreadable even when only the brief was wanted', async () => {
    store.close();
    await writeFile(path.join(dir, STATE_DB_FILENAME), 'this is not a database\n', 'utf8');

    expect(readInjection(dir, { brief: true }).kind).toBe('unreadable');
  });
});

describe('readInjection risk', () => {
  it('reports the risk of the open task, for a host that blocks the call itself', () => {
    forceRow('task-1', { state: stateJson('active', 'goal of task-1', 'destructive') });
    store.close();

    const injection = readInjection(dir);

    expect(injection.kind).toBe('context');
    if (injection.kind !== 'context') throw new Error('unreachable');
    expect(injection.risk).toBe('destructive');
  });

  it('is null when no task is open, so a brief-only injection carries no risk', () => {
    forceRow('task-1', { status: 'done' });
    writePage(store, 'What this project is.');
    store.close();

    const injection = readInjection(dir, { brief: true });

    if (injection.kind !== 'context') throw new Error('unreachable');
    expect(injection.task).toBeNull();
    expect(injection.risk).toBeNull();
  });

  it('drops a risk outside the taxonomy instead of passing it on', () => {
    // A row can hold anything: it is written by whatever build produced it, and a host that
    // blocks tool calls on this value must not act on a word it does not know.
    forceRow('task-1', { state: stateJson('active', 'goal of task-1', 'catastrophic') });
    store.close();

    const injection = readInjection(dir);

    if (injection.kind !== 'context') throw new Error('unreachable');
    expect(injection.risk).toBeNull();
  });
});

describe('readInjection subagent', () => {
  it('renders the orientation instead of Σ, and leaves the default untouched', () => {
    forceRow('task-1', { state: stateJson('active', 'goal of task-1') });
    store.close();

    const text = taskOf(readInjection(dir, { subagent: true }));

    expect(text).toContain('goal: goal of task-1');
    expect(text).toContain('in flight: step one');
    expect(text).toContain('next: continue [risk: safe]');
    expect(text).not.toContain('"artifacts"');
    // A session still gets the whole state: the option is per call, not per root.
    expect(taskOf(readInjection(dir))).toContain('"artifacts"');
  });

  it('still reports a state it cannot parse, brief or not', () => {
    forceRow('task-1', { state: '{"goal": "x", ' });
    store.close();

    const injection = readInjection(dir, { subagent: true });

    expect(injection.kind).toBe('unreadable');
  });
});
