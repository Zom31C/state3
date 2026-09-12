import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS, SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';

/** The one file per project root that holds every task state and every KB page. */
export const STATE_DB_FILENAME = 'state.db';

/** Values SQLite binds. `bigint` is what better-sqlite3 returns for large integers. */
export type SqlParam = null | number | bigint | string | Uint8Array;

export interface SqlRunResult {
  changes: number;
  lastInsertRowid: number;
}

/**
 * Structural subset of a prepared statement. Kept structural for the same reason
 * `StateSchema` in core/skill.ts is: the layers above must not depend on
 * better-sqlite3's generics, and a fake can stand in for tests.
 */
export interface SqlStatement {
  run(...params: SqlParam[]): SqlRunResult;
  get(...params: SqlParam[]): unknown;
  all(...params: SqlParam[]): unknown[];
}

/** Structural subset of the database handle skillState uses. */
export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  exec(sql: string): void;
  /** Runs `fn` inside one transaction, rolling back if it throws. */
  transaction<T>(fn: () => T): T;
  pragma(pragma: string, options?: { simple?: boolean }): unknown;
  close(): void;
}

export class DatabaseSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseSchemaError';
  }
}

/** Wraps driver failures so callers can tell "not our database" from "our bug". */
function describe(file: string, err: unknown): string {
  return `${file}: ${err instanceof Error ? err.message : String(err)}`;
}

function readVersion(db: SqlDatabase): number {
  const value = db.pragma('user_version', { simple: true });
  return typeof value === 'number' ? value : 0;
}

/**
 * Creates or upgrades the schema. Refuses a database from a NEWER skillState:
 * downgrading silently would let this build drop columns it does not know about.
 */
export function ensureSchema(db: SqlDatabase, file: string): { created: boolean; from: number } {
  const from = readVersion(db);

  if (from > SCHEMA_VERSION) {
    throw new DatabaseSchemaError(
      `${file} uses schema version ${from}, but this skillState build only understands ` +
        `up to ${SCHEMA_VERSION}. Upgrade skillState instead of opening this database with an older one.`,
    );
  }

  if (from === SCHEMA_VERSION) return { created: false, from };

  db.transaction(() => {
    if (from === 0) {
      for (const statement of SCHEMA_SQL) db.exec(statement);
    } else {
      for (let version = from; version < SCHEMA_VERSION; version += 1) {
        const steps = MIGRATIONS.get(version);
        if (steps === undefined) {
          throw new DatabaseSchemaError(
            `${file} is at schema version ${version} and this build has no migration to ` +
              `${version + 1}. Restore a backup, or re-run skillState migrate from the JSON export.`,
          );
        }
        for (const statement of steps) db.exec(statement);
      }
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });

  return { created: true, from };
}

export interface OpenOptions {
  /** Open an existing database without creating the file. Used by `doctor`. */
  readonly readOnly?: boolean;
  /**
   * Require the file to exist, but still open it read-write. `doctor` uses this: a
   * read-only connection cannot delete the `-wal`/`-shm` siblings when it closes, so a
   * purely diagnostic command would leave the root with MORE files than it found.
   */
  readonly mustExist?: boolean;
  /** Skip directory creation, for in-memory and temp-file databases. */
  readonly noMkdir?: boolean;
}

/**
 * Opens (and on first use creates) a project's state database.
 *
 * WAL is not optional here: the MCP server and the CLI can hold the same project
 * open at once, and a writer must not block the reader that injects Σ at session
 * start. `busy_timeout` covers the brief writer/writer overlap between them.
 */
export function openStateDatabase(file: string, options: OpenOptions = {}): SqlDatabase {
  const readOnly = options.readOnly === true;
  const mustExist = readOnly || options.mustExist === true;

  // A read-only open must not create anything: `doctor` reports on a state root
  // that may legitimately not exist yet.
  if (!mustExist && file !== ':memory:' && !options.noMkdir) {
    mkdirSync(dirname(file), { recursive: true });
  }

  let db: Database.Database;
  try {
    db = new Database(file, { readonly: readOnly, fileMustExist: mustExist });
  } catch (err) {
    throw new DatabaseSchemaError(
      `cannot open ${describe(file, err)}. If the file is corrupt, restore it from ` +
        'version control or re-run skillState migrate against the JSON export.',
    );
  }

  const handle = wrap(db);
  try {
    if (!readOnly) {
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
    }
    // Page rows reference their parent; without this a deleted parent leaves orphans.
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    if (!readOnly) ensureSchema(handle, file);
  } catch (err) {
    handle.close();
    throw err;
  }

  return handle;
}

/** Adapts better-sqlite3 to the structural port, so nothing above imports the driver. */
function wrap(db: Database.Database): SqlDatabase {
  return {
    prepare: (sql) => {
      const statement = db.prepare(sql);
      return {
        run: (...params: SqlParam[]) => {
          const result = statement.run(...params);
          return {
            changes: Number(result.changes),
            lastInsertRowid: Number(result.lastInsertRowid),
          };
        },
        get: (...params: SqlParam[]) => statement.get(...params),
        all: (...params: SqlParam[]) => statement.all(...params),
      };
    },
    exec: (sql) => {
      db.exec(sql);
    },
    transaction: <T>(fn: () => T): T => db.transaction(fn)(),
    pragma: (pragma, options) =>
      options === undefined ? db.pragma(pragma) : db.pragma(pragma, options),
    close: () => {
      db.close();
    },
  };
}

/**
 * Folds the write-ahead log back into the main file. Call before closing a
 * database that should leave no `-wal`/`-shm` siblings behind — for example when
 * the project is about to be committed or copied.
 */
export function checkpoint(db: SqlDatabase): void {
  db.pragma('wal_checkpoint(TRUNCATE)');
}
