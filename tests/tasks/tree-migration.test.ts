import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStateDatabase, STATE_DB_FILENAME } from '../../src/db/database.js';
import type { SqlDatabase } from '../../src/db/database.js';
import { SCHEMA_VERSION } from '../../src/db/schema.js';
import { readInjection } from '../../src/tasks/inject.js';
import { devTaskSchema } from '../../src/tasks/schema.js';
import type { DevTaskState } from '../../src/tasks/schema.js';
import { TaskStore } from '../../src/tasks/store.js';
import type { FinishReport, StoredTask } from '../../src/tasks/store.js';

let dir: string;
let store: TaskStore | null = null;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'state3-migrated-tree-'));
});

afterEach(async () => {
  store?.close();
  store = null;
  await rm(dir, { recursive: true, force: true });
});

const AT = '2026-01-01T00:00:00.000Z';

const dev = (task: StoredTask): DevTaskState => devTaskSchema.parse(task.state);

/** Σ as a build with no tree would have written it: every field the schema requires, no `parent`. */
function stateOf(goal: string): string {
  return JSON.stringify({
    goal,
    status: 'active',
    plan: [],
    artifacts: {},
    verifications: [],
    decisions: ['carried over from the previous build'],
    blockers: [],
    next: { action: 'Pick the work up again', risk: 'safe' },
  });
}

/**
 * A state root whose database really is one version behind: the column and the index the tree
 * added are gone, and `user_version` says so.
 *
 * Undone rather than built from scratch, because the file worth testing is the one a project
 * already has — written by an older build of this same schema, with its rows in it. The migration
 * is exercised against a database that is behind on its own terms, and the tree against rows that
 * were never created by a build that had one.
 */
function writeRootAtPreviousVersion(tasks: readonly { id: string; goal: string }[]): void {
  const db: SqlDatabase = openStateDatabase(join(dir, STATE_DB_FILENAME));
  for (const task of tasks) {
    db.prepare(
      `INSERT INTO task (id, skill, notation, status, goal, state, created_at, updated_at)
       VALUES (?, 'dev-task', 'plain', 'active', ?, ?, ?, ?)`,
    ).run(task.id, task.goal, stateOf(task.goal), AT, AT);
  }
  // The index goes before the column: SQLite will not drop a column an index reads.
  db.exec('DROP INDEX task_parent');
  db.exec('ALTER TABLE task DROP COLUMN parent');
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
  db.close();
}

describe('a tree on the database the previous version wrote', () => {
  it('migrates on open and reads the carried rows back through the store', async () => {
    writeRootAtPreviousVersion([{ id: 'task-old', goal: 'Work the previous build started' }]);

    store = new TaskStore(dir);

    const task = await store.show('task-old');
    expect(task.meta.parent).toBeNull();
    expect(dev(task).decisions).toEqual(['carried over from the previous build']);
    // The frontier finds it, which is the part a column check cannot show: a migrated row has to
    // answer every question the tree asks of it, not merely exist.
    expect(await store.activeId()).toBe('task-old');
  });

  it('splits a piece out of a task that was created before the tree existed', async () => {
    writeRootAtPreviousVersion([{ id: 'task-old', goal: 'Work the previous build started' }]);
    store = new TaskStore(dir);

    const piece = await store.start('A piece of it', { parent: 'task-old' });

    expect(dev(piece).status).toBe('pending');
    expect(piece.meta.parent).toBe('task-old');
    expect(await store.activeId()).toBe(piece.meta.id);
    expect((await store.list()).find((task) => task.id === 'task-old')?.openSubtasks).toBe(1);
  });

  it('carries the branch in the prompt and hands the queue over, on migrated rows', async () => {
    writeRootAtPreviousVersion([{ id: 'task-old', goal: 'Work the previous build started' }]);
    store = new TaskStore(dir);
    const first = await store.start('First piece', { parent: 'task-old' });
    await store.start('Second piece', { parent: 'task-old' });

    const injection = readInjection(dir);
    expect(injection.kind).toBe('context');
    if (injection.kind !== 'context' || injection.task === null) return;
    expect(injection.task).toContain(
      'Branch: Work the previous build started [active] -> this task',
    );
    expect(injection.task).toContain('Queued after this: "Second piece"');

    const report: FinishReport = {};
    await store.finish('first piece done', first.meta.id, report);
    expect(report.handedOver?.goal).toBe('Second piece');
  });
});
