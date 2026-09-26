import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STATE_DIRNAME } from '../../src/core/paths.js';
import { inspectStateRoot } from '../../src/tasks/doctor.js';
import { readInjection } from '../../src/tasks/inject.js';
import { migrateRootToDatabase } from '../../src/tasks/migrate.js';
import {
  divergedSource,
  LEGACY_STATE_DIRNAME,
  migrateLegacyStateRoot,
  pendingLegacyRoot,
  readMigrationMarker,
  rootMigrationNote,
} from '../../src/tasks/migrate-root.js';
import { TaskStore } from '../../src/tasks/store.js';

let project: string;
let root: string;
let legacy: string;
let store: TaskStore | undefined;
let held: TaskStore | undefined;

beforeEach(async () => {
  project = await mkdtemp(path.join(tmpdir(), 'state3-root-'));
  root = path.join(project, STATE_DIRNAME);
  legacy = path.join(project, LEGACY_STATE_DIRNAME);
  store = undefined;
  held = undefined;
});

afterEach(async () => {
  store?.close();
  held?.close();
  await rm(project, { recursive: true, force: true });
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A pre-rename root holding a real database, written by the store and closed cleanly. */
async function writeLegacyDatabase(goal = 'Task from before the rename'): Promise<void> {
  const old = new TaskStore(legacy);
  await old.start(goal);
  // Held open long enough that the filesystem's clock has moved: a stamp taken in the same tick
  // as the write cannot tell "before the copy" from "after" it, and the check is about order.
  await delay(30);
  old.close();
}

/** Opens the pre-rename database and leaves it open, the way a running session does. */
async function holdLegacyDatabase(): Promise<void> {
  await writeLegacyDatabase();
  held = new TaskStore(legacy);
  // A write, not just an open: SQLite creates the -shm sibling once the WAL is in play.
  await held.start('Written by the session that is still running');
}

describe('migrateLegacyStateRoot', () => {
  it('copies the pre-rename root over, reads it back, and leaves the source in place', async () => {
    await writeLegacyDatabase();

    const result = migrateLegacyStateRoot(root);
    expect(result.kind).toBe('migrated');
    expect(await readdir(legacy)).toContain('state.db');
    expect(readMigrationMarker(root)?.from).toBe(path.resolve(legacy));

    store = new TaskStore(root);
    const list = await store.list();
    expect(list.map((task) => task.goal)).toEqual(['Task from before the rename']);
  });

  it('refuses to copy a database another session is still writing', async () => {
    await holdLegacyDatabase();
    expect(pendingLegacyRoot(root)?.inUse).toBe(true);

    const result = migrateLegacyStateRoot(root);
    expect(result.kind).toBe('in-use');
    expect(existsSync(root)).toBe(false);
    expect(rootMigrationNote(result)).toContain('state.db-shm');
  });

  it('does nothing once the new root holds a database, so two roots are never merged', async () => {
    store = new TaskStore(root);
    await store.start('Written after the rename');
    await writeLegacyDatabase();

    expect(migrateLegacyStateRoot(root).kind).toBe('none');
    expect((await store.list()).map((task) => task.goal)).toEqual(['Written after the rename']);
  });

  it('does nothing for a root that is not the conventional one, whatever sits beside it', async () => {
    await writeLegacyDatabase();
    const chosen = path.join(project, 'a-root-somebody-chose');

    expect(migrateLegacyStateRoot(chosen).kind).toBe('none');
    expect(pendingLegacyRoot(chosen)).toBeNull();
  });

  it('does nothing when there is no pre-rename root to carry over', async () => {
    expect(migrateLegacyStateRoot(root).kind).toBe('none');
    expect(rootMigrationNote(migrateLegacyStateRoot(root))).toBeNull();
  });

  it('carries legacy JSON records over so task migrate can convert them in the new root', async () => {
    await mkdir(legacy, { recursive: true });
    await writeFile(
      path.join(legacy, 'task-old.json'),
      JSON.stringify({
        id: 'task-old',
        createdAt: '2026-09-07T18:30:59.046Z',
        updatedAt: '2026-09-07T22:13:55.832Z',
        skill: 'dev-task',
        notation: 'plain',
        state: {
          goal: 'Record from the JSON layout',
          status: 'active',
          plan: [{ id: '1', task: 'step one', status: 'in_progress', notes: '' }],
          artifacts: {},
          verifications: [],
          decisions: [],
          blockers: [],
          next: { action: 'continue', risk: 'safe' },
        },
      }),
      'utf-8',
    );

    const report = await migrateRootToDatabase(root);
    expect(report.rootNote).not.toBeNull();
    expect(report.migrated.map((task) => task.id)).toEqual(['task-old']);
  });
});

describe('the read path', () => {
  it('injects Σ out of a pre-rename root without a tool call having carried it over', async () => {
    await writeLegacyDatabase();

    const injection = readInjection(root);
    expect(injection.kind).toBe('context');
    if (injection.kind !== 'context') return;
    expect(injection.task).toContain('Task from before the rename');
  });

  it('reports a refused carry-over instead of answering that the project has no state', async () => {
    await holdLegacyDatabase();

    const injection = readInjection(root);
    expect(injection.kind).toBe('unreadable');
    if (injection.kind !== 'unreadable') return;
    expect(injection.reason).toContain('NOT carried over');
  });
});

describe('pendingLegacyRoot', () => {
  it('probes without changing anything, which is what lets doctor report it', async () => {
    await writeLegacyDatabase();

    expect(pendingLegacyRoot(root)?.from).toBe(path.resolve(legacy));
    expect(existsSync(root)).toBe(false);

    const before = await inspectStateRoot(root);
    expect(before.findings.some((f) => f.text.includes('has not been carried over yet'))).toBe(
      true,
    );

    migrateLegacyStateRoot(root);
    const after = await inspectStateRoot(root);
    expect(
      after.findings.some((f) => f.text.includes('carried over from the pre-rename name')),
    ).toBe(true);
  });
});

describe('the two roots after a carry-over', () => {
  it('remembers what it copied, and stays quiet while the old root is untouched', async () => {
    await writeLegacyDatabase();
    migrateLegacyStateRoot(root);

    const stamp = readMigrationMarker(root);
    expect(stamp?.from).toBe(path.resolve(legacy));
    expect(stamp?.source).not.toBeNull();
    expect(divergedSource(root)).toBeNull();
    expect((await inspectStateRoot(root)).findings.some((f) => f.text.includes('diverged'))).toBe(
      false,
    );
  });

  it('says out loud when the pre-rename root is written after the copy', async () => {
    await writeLegacyDatabase();
    migrateLegacyStateRoot(root);

    // What a host still linked to the old extension, or a script with --root .skillstate, does:
    // it opens the root it was pointed at and writes, and nothing about the file says it is stale.
    const old = new TaskStore(legacy);
    await old.start('Written into the old root after the carry-over');
    // Held apart in time from the copy, as a real second write would be. Note what the check
    // actually catches: SQLite reused pages here, so the file size came back identical and only
    // the mtime moved — a stamp of size alone would have reported nothing.
    await delay(30);
    old.close();

    const diverged = divergedSource(root);
    expect(diverged).not.toBeNull();
    expect((await inspectStateRoot(root)).findings.some((f) => f.text.includes('diverged'))).toBe(
      true,
    );

    const atStart = readInjection(root, { drift: true });
    expect(atStart.kind).toBe('context');
    if (atStart.kind === 'context') expect(atStart.task).toContain('diverged');

    // Once per session, like artifact drift: a surprise repeated on every prompt costs more than
    // the surprise is worth.
    const onPrompt = readInjection(root);
    if (onPrompt.kind === 'context') expect(onPrompt.task).not.toContain('diverged');
  });

  it('is quiet about a pre-rename root that has since been deleted', async () => {
    await writeLegacyDatabase();
    migrateLegacyStateRoot(root);
    await rm(legacy, { recursive: true, force: true });

    expect(divergedSource(root)).toBeNull();
  });

  it('claims no comparison it cannot make for a root that held only legacy JSON', async () => {
    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(legacy, 'task-old.json'), '{"id":"task-old"}', 'utf-8');
    migrateLegacyStateRoot(root);

    expect(readMigrationMarker(root)?.source).toBeNull();
    // The records were archived rather than read here, so there is no database stamp to compare
    // against; reporting divergence would be a claim about a file nobody measured.
    await writeFile(path.join(legacy, 'task-old.json'), '{"id":"task-old","edited":true}', 'utf-8');
    expect(divergedSource(root)).toBeNull();
  });
});
