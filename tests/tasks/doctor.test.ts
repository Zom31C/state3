import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStateDatabase } from '../../src/db/database.js';
import { SCHEMA_VERSION } from '../../src/db/schema.js';
import { formatDoctorReport, inspectStateRoot } from '../../src/tasks/doctor.js';
import { TaskStore } from '../../src/tasks/store.js';

let dir: string;
const open: { close(): void }[] = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'skillstate-doctor-'));
});

afterEach(async () => {
  while (open.length > 0) open.pop()?.close();
  await rm(dir, { recursive: true, force: true });
});

function track<T extends { close(): void }>(value: T): T {
  open.push(value);
  return value;
}

function dbPath(): string {
  return path.join(dir, 'state.db');
}

/** A real store, so the database is created by the code under test, not by hand. */
async function storeWithTask(goal = 'A healthy task'): Promise<TaskStore> {
  const store = track(new TaskStore(dir));
  await store.start(goal);
  return store;
}

function severities(report: { findings: { severity: string }[] }): string[] {
  return report.findings.map((finding) => finding.severity);
}

describe('inspectStateRoot', () => {
  it('warns about a file artifact that changed after Σ was written', async () => {
    const store = await storeWithTask();
    await writeFile(path.join(dir, 'a.ts'), 'one');
    await store.patch({ artifacts: { 'a.ts': 'the reader' } });
    await writeFile(path.join(dir, 'a.ts'), 'one two three, edited by hand overnight');
    store.close();

    const report = await inspectStateRoot(dir);
    const text = formatDoctorReport(report);

    expect(severities(report)).toContain('warn');
    expect(text).toContain('describes a file that moved since Σ was written');
    expect(text).toContain('a.ts (modified');
  });

  it('says nothing about artifacts while the tree still matches Σ', async () => {
    const store = await storeWithTask();
    await writeFile(path.join(dir, 'a.ts'), 'one');
    await store.patch({ artifacts: { 'a.ts': 'the reader' } });
    store.close();

    expect(formatDoctorReport(await inspectStateRoot(dir))).not.toContain('file that moved');
  });

  it('reports an empty root without creating anything', async () => {
    const report = await inspectStateRoot(dir);

    expect(report.databaseExists).toBe(false);
    expect(report.counts.tasks).toBe(0);
    expect(severities(report)).not.toContain('fail');
    expect(formatDoctorReport(report)).toContain('absent');
  });

  it('reports a healthy database as ok, with its counts and schema version', async () => {
    const store = await storeWithTask();
    await store.patch({ decisions: ['one'] });
    store.close();

    const report = await inspectStateRoot(dir);
    expect(report.databaseExists).toBe(true);
    expect(report.schemaVersion).toBe(SCHEMA_VERSION);
    expect(report.integrity).toBe('ok');
    expect(report.counts.tasks).toBe(1);
    expect(report.counts.taskHistory).toBe(1);
    expect(report.counts.searchRows).toBe(1);
    expect(report.unreadableTasks).toEqual([]);
    expect(report.danglingLinks).toEqual([]);
    expect(severities(report)).not.toContain('warn');
    expect(severities(report)).not.toContain('fail');
    expect(formatDoctorReport(report)).toContain('nothing to fix');
  });

  it('points at migrate while legacy JSON records are still in the root', async () => {
    await writeFile(
      path.join(dir, 'task-legacy-0001.json'),
      JSON.stringify({
        id: 'task-legacy-0001',
        createdAt: '2026-09-07T18:30:59.046Z',
        updatedAt: '2026-09-07T22:13:55.832Z',
        state: { goal: 'old', status: 'active' },
      }),
      'utf-8',
    );

    const report = await inspectStateRoot(dir);
    const text = formatDoctorReport(report);
    expect(text).toContain('legacy JSON task record');
    expect(text).toContain('migrate');
    // Nothing was migrated by looking, and no database was created by the inspection.
    expect(report.databaseExists).toBe(false);
  });

  it('names a stored task this runtime cannot read', async () => {
    const store = await storeWithTask();
    store
      .database()
      .prepare('UPDATE task SET skill = ? WHERE id = (SELECT id FROM task LIMIT 1)')
      .run('alien-task');
    const visible = await store.list();
    expect(visible).toHaveLength(0);
    store.close();

    const report = await inspectStateRoot(dir);
    expect(report.unreadableTasks).toHaveLength(1);
    expect(report.unreadableTasks[0]?.reason).toContain('alien-task');
    expect(formatDoctorReport(report)).toContain('WARN');
  });

  it('fails when the search index no longer matches the rows it indexes', async () => {
    const store = await storeWithTask();
    store.database().prepare('DELETE FROM search').run();
    store.close();

    const report = await inspectStateRoot(dir);
    expect(report.counts.searchRows).toBe(0);
    expect(severities(report)).toContain('fail');
    expect(formatDoctorReport(report)).toContain('out of sync');
  });

  it('reports a dangling link edge', async () => {
    const store = await storeWithTask();
    const db = store.database();
    db.prepare(
      `INSERT INTO page (id, kind, title, summary, body, status, created_at, updated_at)
       VALUES ('real', 'note', 'Real page', '', '', 'current', 't', 't')`,
    ).run();
    db.prepare(
      `INSERT INTO link (src_kind, src_id, rel, dst_kind, dst_id)
       VALUES ('page', 'real', 'documents', 'page', 'gone')`,
    ).run();
    store.close();

    const report = await inspectStateRoot(dir);
    expect(report.danglingLinks).toEqual([
      { from: 'page:real', to: 'page:gone', rel: 'documents' },
    ]);
    expect(formatDoctorReport(report)).toContain('dangling link');
  });

  it('fails on a schema version this build does not know, and puts FAIL first', async () => {
    const store = await storeWithTask();
    store.close();

    const db = track(openStateDatabase(dbPath()));
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    open.pop();

    const report = await inspectStateRoot(dir);
    expect(report.schemaVersion).toBe(SCHEMA_VERSION + 1);
    const text = formatDoctorReport(report);
    expect(text).toContain('FAIL');
    expect(text.indexOf('FAIL')).toBeLessThan(text.indexOf('OK '));
  });

  it('reports a database it cannot open instead of throwing', async () => {
    await writeFile(dbPath(), 'this is not a SQLite database at all', 'utf-8');

    const report = await inspectStateRoot(dir);
    expect(report.databaseExists).toBe(true);
    expect(report.integrity).toBeNull();
    expect(severities(report)).toContain('fail');
    // SQLite rejects a foreign file lazily, so the failure may surface on open or on
    // the first read; either way doctor reports it rather than throwing.
    expect(formatDoctorReport(report)).toMatch(/cannot (open|inspect) the database/);
  });

  it('leaves the root with the single database file, folding the WAL back', async () => {
    const store = await storeWithTask();
    store.close();

    await inspectStateRoot(dir);

    // A read-only connection cannot delete the WAL siblings, so without the tidy pass a
    // purely diagnostic command would leave the root with more files than it found.
    expect(await readdir(dir)).toEqual(['state.db']);
  });

  it('does not write to a database whose schema version it does not recognise', async () => {
    const store = await storeWithTask();
    store.database().exec('PRAGMA user_version = 0');
    store.close();
    const before = await readFile(dbPath());

    const report = await inspectStateRoot(dir);

    expect(report.schemaVersion).toBe(0);
    expect(severities(report)).toContain('fail');
    expect((await readFile(dbPath())).equals(before)).toBe(true);
  });
});
