import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSchemaError, checkpoint, openStateDatabase } from '../../src/db/database.js';
import type { SqlDatabase } from '../../src/db/database.js';
import { SCHEMA_VERSION } from '../../src/db/schema.js';

const dirs: string[] = [];
const open: SqlDatabase[] = [];

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'state3-db-'));
  dirs.push(dir);
  return join(dir, '.state3', 'state.db');
}

function track(db: SqlDatabase): SqlDatabase {
  open.push(db);
  return db;
}

function insertTask(db: SqlDatabase, id: string, goal: string, status = 'active'): void {
  db.prepare(
    `INSERT INTO task (id, skill, notation, status, goal, state, created_at, updated_at)
     VALUES (?, 'dev-task', 'plain', ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run(id, status, goal, JSON.stringify({ goal, status }));
}

function insertPage(
  db: SqlDatabase,
  id: string,
  title: string,
  summary: string,
  body: string,
): void {
  db.prepare(
    `INSERT INTO page (id, kind, title, summary, body, status, created_at, updated_at)
     VALUES (?, 'guide', ?, ?, ?, 'current', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run(id, title, summary, body);
}

function match(db: SqlDatabase, query: string): string[] {
  return db
    .prepare("SELECT ref_kind || ':' || ref_id AS ref FROM search WHERE search MATCH ?")
    .all(query)
    .map((row) => (row as { ref: string }).ref);
}

afterEach(() => {
  while (open.length > 0) open.pop()?.close();
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('openStateDatabase', () => {
  it('creates the parent directory and stamps the schema version on first open', () => {
    const file = tempFile();
    expect(existsSync(file)).toBe(false);

    const db = track(openStateDatabase(file));
    expect(existsSync(file)).toBe(true);
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
  });

  it('creates every table the schema declares', () => {
    const db = track(openStateDatabase(tempFile()));
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger') ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);

    for (const expected of [
      'meta',
      'task',
      'task_history',
      'page',
      'link',
      'search',
      'search_task_insert',
      'search_page_insert',
    ]) {
      expect(names, `missing ${expected}`).toContain(expected);
    }
  });

  it('is idempotent: reopening an existing database neither errors nor recreates it', () => {
    const file = tempFile();
    const first = track(openStateDatabase(file));
    insertTask(first, 'task-1', 'survive a reopen');
    first.close();
    open.pop();

    const second = track(openStateDatabase(file));
    const row = second.prepare('SELECT goal FROM task WHERE id = ?').get('task-1') as
      { goal: string } | undefined;
    expect(row?.goal).toBe('survive a reopen');
    expect(second.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
  });

  it('uses WAL so a writer never blocks the reader that injects Σ at session start', () => {
    const db = track(openStateDatabase(tempFile()));
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
  });

  it('rolls back a transaction that throws', () => {
    const db = track(openStateDatabase(tempFile()));
    expect(() =>
      db.transaction(() => {
        insertTask(db, 'task-rollback', 'must not survive');
        throw new Error('boom');
      }),
    ).toThrow('boom');

    expect(db.prepare('SELECT id FROM task').all()).toEqual([]);
  });

  it('refuses a database written by a newer state3 instead of downgrading it', () => {
    const file = tempFile();
    const db = track(openStateDatabase(file));
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    open.pop();

    expect(() => openStateDatabase(file)).toThrow(DatabaseSchemaError);
    expect(() => openStateDatabase(file)).toThrow(/schema version/);
  });

  it('reports a missing database as a schema error when opened read-only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'state3-db-ro-'));
    dirs.push(dir);
    expect(() => track(openStateDatabase(join(dir, 'absent.db'), { readOnly: true }))).toThrow(
      DatabaseSchemaError,
    );
  });

  it('supports an in-memory database so tests need no filesystem', () => {
    const db = track(openStateDatabase(':memory:'));
    insertTask(db, 'task-mem', 'in memory');
    expect(match(db, 'memory')).toEqual(['task:task-mem']);
  });

  it('checkpoint folds the WAL back without throwing', () => {
    const db = track(openStateDatabase(tempFile()));
    insertTask(db, 'task-1', 'checkpoint me');
    expect(() => checkpoint(db)).not.toThrow();
  });
});

describe('migrating an older database forward', () => {
  /**
   * The search index as version 5 had it: five columns, because the sixth (`symbols`) only
   * arrives with the rebuild in 5 -> 6. Recreated by hand, like the triggers inside it,
   * because a migration test is worth nothing against a file that is not really behind — and
   * because the rebuild has to REPLACE these: `CREATE TRIGGER IF NOT EXISTS` would leave them
   * in place, and every symbol written afterwards would be missing from the search, silently.
   */
  const INDEX_WITHOUT_SYMBOLS_SQL: readonly string[] = [
    `CREATE VIRTUAL TABLE search USING fts5(
      ref_kind UNINDEXED,
      ref_id   UNINDEXED,
      title,
      summary,
      body,
      tokenize = 'unicode61 remove_diacritics 2'
    )`,
    `CREATE TRIGGER search_task_insert AFTER INSERT ON task BEGIN
      INSERT INTO search (ref_kind, ref_id, title, summary, body)
      VALUES ('task', new.id, new.goal, '', new.state);
    END`,
    `CREATE TRIGGER search_task_update AFTER UPDATE ON task BEGIN
      DELETE FROM search WHERE ref_kind = 'task' AND ref_id = old.id;
      INSERT INTO search (ref_kind, ref_id, title, summary, body)
      VALUES ('task', new.id, new.goal, '', new.state);
    END`,
    `CREATE TRIGGER search_page_insert AFTER INSERT ON page BEGIN
      INSERT INTO search (ref_kind, ref_id, title, summary, body)
      VALUES ('page', new.id, new.title, new.summary, new.body);
    END`,
    `CREATE TRIGGER search_page_update AFTER UPDATE ON page BEGIN
      DELETE FROM search WHERE ref_kind = 'page' AND ref_id = old.id;
      INSERT INTO search (ref_kind, ref_id, title, summary, body)
      VALUES ('page', new.id, new.title, new.summary, new.body);
    END`,
  ];

  /**
   * A database at an older schema version, made by undoing what the later migrations add.
   * The migration path has to be exercised against a file that really is behind, because
   * every project already using state3 has one.
   */
  function databaseAtVersion(file: string, version: number): void {
    const db = track(openStateDatabase(file));
    insertPage(db, 'project', 'Drift Ages', 'A driving game.', 'Physics lives in scripts/.');
    // The index goes before the column: SQLite will not drop a column an index reads.
    if (version < 7) {
      db.exec('DROP INDEX task_parent');
      db.exec('ALTER TABLE task DROP COLUMN parent');
    }
    if (version < 6) {
      db.exec('DROP TRIGGER search_task_insert');
      db.exec('DROP TRIGGER search_task_update');
      db.exec('DROP TRIGGER search_page_insert');
      db.exec('DROP TRIGGER search_page_update');
      db.exec('DROP TABLE search');
      for (const statement of INDEX_WITHOUT_SYMBOLS_SQL) db.exec(statement);
    }
    // SQLite will not drop a column a trigger reads, which is why the index above — and with it
    // the triggers that mention `symbols` — is undone first.
    if (version < 5) db.exec('ALTER TABLE page DROP COLUMN symbols');
    if (version < 4) db.exec('DROP TABLE artifact_stamp');
    if (version < 3) {
      db.exec('ALTER TABLE page DROP COLUMN source_commit');
      db.exec('ALTER TABLE page DROP COLUMN source_files');
    }
    if (version < 2) db.exec('DROP TABLE page_history');
    db.exec(`PRAGMA user_version = ${version}`);
    db.close();
    open.pop();
  }

  /** The columns a version added, read back through a write: existing is not enough. */
  function expectUsable(db: SqlDatabase): void {
    expect(() =>
      db
        .prepare('INSERT INTO page_history (page_id, at, body) VALUES (?, ?, ?)')
        .run('project', '2026-09-18T10:00:00.000Z', 'an older body'),
    ).not.toThrow();
    expect(() =>
      db
        .prepare('UPDATE page SET source_commit = ?, source_files = ? WHERE id = ?')
        .run('abc1234', 'scripts/Car.cs', 'project'),
    ).not.toThrow();
    expect(() =>
      db
        .prepare('UPDATE page SET symbols = ? WHERE id = ?')
        .run('Car.ApplyInput — scripts/Car.cs', 'project'),
    ).not.toThrow();
    // Read rather than written: a stamp row references a task, and this database has none.
    expect(db.prepare('SELECT count(*) AS n FROM artifact_stamp').get()).toEqual({ n: 0 });
    // Asked the way the injection asks it: a carried-over database has no subtasks, so the
    // answer is the point — the query only runs at all if the column is really there.
    expect(db.prepare('SELECT count(*) AS n FROM task WHERE parent IS NOT NULL').get()).toEqual({
      n: 0,
    });
  }

  it('adds what the new version needs and keeps every row that was there', () => {
    const file = tempFile();
    databaseAtVersion(file, SCHEMA_VERSION - 1);

    const db = track(openStateDatabase(file));

    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(db.prepare('SELECT title, body FROM page WHERE id = ?').get('project')).toEqual({
      title: 'Drift Ages',
      body: 'Physics lives in scripts/.',
    });
    expectUsable(db);
    expect(db.prepare('SELECT count(*) AS n FROM page_history').get()).toEqual({ n: 1 });
  });

  it('runs every migration between a database two versions back and this build', () => {
    const file = tempFile();
    databaseAtVersion(file, SCHEMA_VERSION - 2);

    const db = track(openStateDatabase(file));

    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(db.prepare('SELECT source_commit FROM page WHERE id = ?').get('project')).toEqual({
      // A row carried over has no anchor: it was written before there was one to record,
      // and inventing HEAD would claim a freshness nobody checked.
      source_commit: null,
    });
    expectUsable(db);
  });

  it('search still answers for a page carried over by the migration', () => {
    const file = tempFile();
    databaseAtVersion(file, SCHEMA_VERSION - 2);

    expect(match(track(openStateDatabase(file)), 'physics')).toEqual(['page:project']);
  });

  it('repairs a database stamped 5, where the column existed but the index did not', () => {
    // The state a build carrying only the first half of the change leaves behind, and the
    // reason the rebuild is its own version: `page.symbols` is there, the index has no such
    // column, and every search fails — while the version number says the schema is current.
    const file = tempFile();
    databaseAtVersion(file, SCHEMA_VERSION - 1);

    const db = track(openStateDatabase(file));

    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    // The rebuild refills the index from the rows it indexes, so what was there stays findable.
    expect(match(db, 'physics')).toEqual(['page:project']);

    db.prepare('UPDATE page SET symbols = ? WHERE id = ?').run(
      'RoadMask — scripts/RoadNetwork.cs',
      'project',
    );
    expect(match(db, 'RoadMask')).toEqual(['page:project']);
  });
});

describe('search index triggers', () => {
  it('indexes a task on insert, re-indexes it on update, and drops it on delete', () => {
    const db = track(openStateDatabase(tempFile()));

    insertTask(db, 'task-1', 'migrate the storage layer');
    expect(match(db, 'migrate')).toEqual(['task:task-1']);

    db.prepare('UPDATE task SET goal = ?, state = ? WHERE id = ?').run(
      'rewrite the onboarding guide',
      JSON.stringify({ goal: 'rewrite the onboarding guide' }),
      'task-1',
    );
    expect(match(db, 'migrate')).toEqual([]);
    expect(match(db, 'onboarding')).toEqual(['task:task-1']);

    db.prepare('DELETE FROM task WHERE id = ?').run('task-1');
    expect(match(db, 'onboarding')).toEqual([]);
  });

  it('indexes page title, summary and body separately from the task namespace', () => {
    const db = track(openStateDatabase(tempFile()));
    insertPage(db, 'build', 'How to build', 'One command builds dist', 'Run npm run build');

    expect(match(db, 'build')).toContain('page:build');
    expect(match(db, 'command')).toEqual(['page:build']);
    expect(match(db, 'dist')).toEqual(['page:build']);
  });

  it('finds Cyrillic text, because the knowledge base is written in the user language', () => {
    const db = track(openStateDatabase(tempFile()));
    insertPage(db, 'proekt', 'Описание проекта', 'Что хочет пользователь', 'Документация и фичи');

    expect(match(db, 'документация')).toEqual(['page:proekt']);
    expect(match(db, 'пользователь')).toEqual(['page:proekt']);
  });

  it('cascades task_history rows when a task is deleted', () => {
    const db = track(openStateDatabase(tempFile()));
    insertTask(db, 'task-1', 'audited');
    db.prepare(
      `INSERT INTO task_history (task_id, at, ok, patch) VALUES (?, '2026-01-01T00:00:00.000Z', 1, '{}')`,
    ).run('task-1');

    expect(db.prepare('SELECT seq FROM task_history').all()).toHaveLength(1);
    db.prepare('DELETE FROM task WHERE id = ?').run('task-1');
    expect(db.prepare('SELECT seq FROM task_history').all()).toHaveLength(0);
  });

  it('detaches a child page instead of orphaning it when its parent is deleted', () => {
    const db = track(openStateDatabase(tempFile()));
    insertPage(db, 'parent', 'Parent', '', '');
    insertPage(db, 'child', 'Child', '', '');
    db.prepare('UPDATE page SET parent = ? WHERE id = ?').run('parent', 'child');

    db.prepare('DELETE FROM page WHERE id = ?').run('parent');
    const row = db.prepare('SELECT parent FROM page WHERE id = ?').get('child') as {
      parent: string | null;
    };
    expect(row.parent).toBeNull();
  });
});
