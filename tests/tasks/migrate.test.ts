import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StateDict } from '../../src/core/types.js';
import { migrateRootToDatabase, formatMigrationReport } from '../../src/tasks/migrate.js';
import { TaskStore } from '../../src/tasks/store.js';

let dir: string;
let store: TaskStore | undefined;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'skillstate-migrate-'));
  store = undefined;
});

afterEach(async () => {
  store?.close();
  await rm(dir, { recursive: true, force: true });
});

/** A task record exactly as the file-backed store wrote it. */
function legacyRecord(id: string, extra: StateDict = {}): string {
  return JSON.stringify({
    id,
    createdAt: '2026-09-07T18:30:59.046Z',
    updatedAt: '2026-09-07T22:13:55.832Z',
    skill: 'dev-task',
    notation: 'plain',
    state: {
      goal: 'Task from an older runtime',
      status: 'active',
      plan: [{ id: '1', task: 'step one', status: 'in_progress', notes: '' }],
      artifacts: { 'src/a.ts': 'the thing' },
      verifications: [{ check: 'npm test', status: 'pass' }],
      decisions: ['decided earlier'],
      blockers: [],
      next: { action: 'continue', risk: 'safe' },
    },
    ...extra,
  });
}

function legacyHistory(): string {
  return [
    JSON.stringify({ at: '2026-09-07T19:00:00.000Z', patch: { decisions: ['one'] }, ok: true }),
    JSON.stringify({
      at: '2026-09-07T19:05:00.000Z',
      patch: { bogus: 'x' },
      ok: false,
      error: { category: 'unknown-key', message: 'unknown key "bogus"' },
    }),
    '',
  ].join('\n');
}

async function writeLegacy(id: string, record = legacyRecord(id)): Promise<void> {
  await writeFile(path.join(dir, `${id}.json`), record, 'utf-8');
  await writeFile(path.join(dir, `${id}.history.jsonl`), legacyHistory(), 'utf-8');
}

function openStore(): TaskStore {
  store = new TaskStore(dir);
  return store;
}

describe('migrateRootToDatabase', () => {
  it('imports a legacy task and its audit trail, preserving id, timestamps and Σ', async () => {
    await writeLegacy('task-legacy-0001');

    const report = await migrateRootToDatabase(dir);
    expect(report.migrated).toHaveLength(1);
    expect(report.migrated[0]).toMatchObject({
      id: 'task-legacy-0001',
      skill: 'dev-task',
      historyEntries: 2,
      readable: true,
    });

    const shown = await openStore().show('task-legacy-0001');
    expect(shown.meta.createdAt).toBe('2026-09-07T18:30:59.046Z');
    expect(shown.meta.updatedAt).toBe('2026-09-07T22:13:55.832Z');
    expect(shown.meta.notation).toBe('plain');
    expect(shown.state.artifacts).toEqual({ 'src/a.ts': 'the thing' });
    expect(shown.state.decisions).toEqual(['decided earlier']);
  });

  it('keeps the rejected entries of the audit trail, with their category', async () => {
    await writeLegacy('task-legacy-0002');
    await migrateRootToDatabase(dir);

    const history = await openStore().history('task-legacy-0002');
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ ok: true, patch: { decisions: ['one'] } });
    expect(history[1]).toMatchObject({ ok: false, patch: { bogus: 'x' } });
    expect(history[1]?.error?.category).toBe('unknown-key');
  });

  it('keeps listing, progress and the active task working after the move', async () => {
    await writeLegacy('task-legacy-0003');
    await migrateRootToDatabase(dir);

    const opened = openStore();
    const all = await opened.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: 'task-legacy-0003', skill: 'dev-task', status: 'active' });
    expect(all[0]?.progressDone).toBe(0);
    expect(all[0]?.progressTotal).toBe(1);
    expect(await opened.activeId()).toBe('task-legacy-0003');
  });

  it('is idempotent: a second run reports the task as already present and changes nothing', async () => {
    await writeLegacy('task-legacy-0004');
    await migrateRootToDatabase(dir, { keepFiles: true });

    const second = await migrateRootToDatabase(dir, { keepFiles: true });
    expect(second.migrated).toHaveLength(0);
    expect(second.alreadyInDatabase).toEqual(['task-legacy-0004']);

    const history = await openStore().history('task-legacy-0004');
    expect(history).toHaveLength(2);
  });

  it('fills in the defaults for a record written before skills and notation existed', async () => {
    const bare = JSON.stringify({
      id: 'task-legacy-0005',
      createdAt: '2026-09-07T18:30:59.046Z',
      updatedAt: '2026-09-07T22:13:55.832Z',
      state: JSON.parse(legacyRecord('x')).state,
    });
    await writeFile(path.join(dir, 'task-legacy-0005.json'), bare, 'utf-8');

    await migrateRootToDatabase(dir);
    const shown = await openStore().show('task-legacy-0005');
    expect(shown.meta.skill).toBe('dev-task');
    expect(shown.meta.notation).toBe('plain');
  });

  it('moves the legacy files into a timestamped archive by default', async () => {
    await writeLegacy('task-legacy-0006');

    const report = await migrateRootToDatabase(dir);
    expect(report.archivedTo).not.toBeNull();
    expect(report.filesHandled).toBe(2);

    const entries = await readdir(dir);
    expect(entries).toContain('state.db');
    expect(entries.filter((name) => name.endsWith('.json'))).toEqual([]);
    expect(entries.filter((name) => name.endsWith('.jsonl'))).toEqual([]);

    const archived = await readdir(report.archivedTo as string);
    expect(archived.sort()).toEqual(['task-legacy-0006.history.jsonl', 'task-legacy-0006.json']);
  });

  it('deletes the legacy files when asked to purge', async () => {
    await writeLegacy('task-legacy-0007');

    const report = await migrateRootToDatabase(dir, { purge: true });
    expect(report.archivedTo).toBeNull();
    expect(report.filesHandled).toBe(2);

    const entries = (await readdir(dir)).filter((name) => name.startsWith('state.db'));
    expect(entries).toEqual(['state.db']);
  });

  it('leaves the legacy files untouched with keepFiles, so the import can be inspected first', async () => {
    await writeLegacy('task-legacy-0008');

    const report = await migrateRootToDatabase(dir, { keepFiles: true });
    expect(report.archivedTo).toBeNull();
    expect(report.filesHandled).toBe(0);
    expect(await readFile(path.join(dir, 'task-legacy-0008.json'), 'utf-8')).toContain(
      'task-legacy-0008',
    );
  });

  it('imports a record naming a foreign skill instead of losing it, and says it cannot read it', async () => {
    await writeFile(
      path.join(dir, 'task-alien-0001.json'),
      legacyRecord('task-alien-0001', { skill: 'alien-task' }),
      'utf-8',
    );

    const report = await migrateRootToDatabase(dir);
    expect(report.migrated[0]?.readable).toBe(false);
    expect(report.migrated[0]?.reason).toContain('alien-task');

    const opened = openStore();
    await expect(opened.show('task-alien-0001')).rejects.toThrow(/does not have/);
    expect(await opened.list()).toHaveLength(0);
  });

  it('reports an unparseable file and leaves it where it is', async () => {
    await writeLegacy('task-good-0001');
    await writeFile(path.join(dir, 'task-broken-0001.json'), '{ not valid json', 'utf-8');

    const report = await migrateRootToDatabase(dir);
    expect(report.migrated.map((task) => task.id)).toEqual(['task-good-0001']);
    expect(report.unreadable).toHaveLength(1);
    expect(report.unreadable[0]?.reason).toContain('not valid JSON');

    const left = await readdir(dir);
    expect(left).toContain('task-broken-0001.json');
    expect(formatMigrationReport(report)).toContain('UNREADABLE');
  });

  it('creates no database at all in a root that has nothing to migrate', async () => {
    const report = await migrateRootToDatabase(dir);
    expect(report.migrated).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
    expect(formatMigrationReport(report)).toContain('nothing to migrate');
  });

  it('migrates several tasks and keeps their relative order', async () => {
    await writeLegacy('task-older');
    await writeFile(
      path.join(dir, 'task-newer.json'),
      legacyRecord('task-newer', { updatedAt: '2026-09-09T10:00:00.000Z' }),
      'utf-8',
    );

    await migrateRootToDatabase(dir);
    const opened = openStore();
    const all = await opened.list();
    expect(all.map((task) => task.id)).toEqual(['task-newer', 'task-older']);
    expect(await opened.activeId()).toBe('task-newer');
  });
});
