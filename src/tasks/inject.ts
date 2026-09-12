import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isPlainObject } from '../core/state.js';
import type { StateDict, StateValue } from '../core/types.js';
import { STATE_DB_FILENAME, openStateDatabase } from '../db/database.js';
import type { SqlDatabase } from '../db/database.js';
import { renderDatabaseBrief } from '../kb/brief.js';
import { DEFAULT_NOTATION, isNotation } from './notation.js';
import { renderTaskBrief, renderTaskHead } from './render.js';
import { RISK_LEVELS } from './schema.js';
import type { RiskLevel } from './schema.js';
import type { StoredTask, TaskMeta } from './store.js';

/**
 * What one state root holds for a hook to inject. Every kind tells the caller something
 * different, so a root that cannot be read is never reported as a root with nothing in it.
 */
export type Injection =
  /** No `state.db` here: the root is empty, or still in the legacy JSON layout. */
  | { kind: 'none' }
  /** The database is there but this build could not read it. `reason` is safe to show a user. */
  | { kind: 'unreadable'; reason: string }
  /** Read fine, and this root has nothing to inject: no open task, and no pages to brief. */
  | { kind: 'idle' }
  /**
   * What to inject. A half that is null is a half this root has nothing to say in. `risk` is the
   * task's `next.risk`, for a host that enforces the confirmation rule itself.
   */
  | { kind: 'context'; task: string | null; brief: string | null; risk: RiskLevel | null };

export interface InjectionOptions {
  /**
   * Also read the knowledge-base brief. A session start is the one moment it pays for itself: it
   * is the point at which the transcript holds nothing, and from the second prompt onwards the
   * same text would be a tax on every turn for a map the session has already seen.
   */
  brief?: boolean;
  /**
   * Render the task as the few lines a delegated subagent needs instead of Σ. A subagent has no
   * transcript and usually no skillstate tools, so it needs to know a task exists and which step
   * is in flight — not the whole state, which it would pay for on every one of its turns. The
   * full Σ and the procedure stay behind `task_show`.
   */
  subagent?: boolean;
}

interface CandidateRow {
  id: string;
  skill: string;
  notation: string;
  state: string;
  created_at: string;
  updated_at: string;
}

function candidateSql(where: string): string {
  return `SELECT id, skill, notation, state, created_at, updated_at FROM task
          WHERE ${where} ORDER BY updated_at DESC, id DESC LIMIT 1`;
}

/**
 * The task a hook injects: the most recently updated open one, `active` first.
 * Mirrors TaskStore.activeId(), but as two indexed queries — a hook runs on every prompt
 * and must not deserialize every task in the project to find the one it needs.
 */
function pickCandidate(db: SqlDatabase): CandidateRow | null {
  const active = db.prepare(candidateSql(`status = 'active'`)).get() as CandidateRow | undefined;
  if (active !== undefined) return active;
  const open = db.prepare(candidateSql(`status <> 'done'`)).get() as CandidateRow | undefined;
  return open ?? null;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Σ of the task to inject, or the reason it could not be read; `text` is null when none is open. */
interface TaskHead {
  text: string | null;
  risk: RiskLevel | null;
  unreadable: string | null;
}

/**
 * The task's `next.risk`, whatever skill owns Σ.
 *
 * A host that enforces the confirmation rule — the opencode guard blocks `bash`/`write` while
 * the next action is destructive — needs the level, and it must come from the same read that
 * produced the text: a second query is a second chance to disagree with the first.
 */
function riskOf(state: StateDict): RiskLevel | null {
  const next = state.next;
  if (!isPlainObject(next)) return null;
  const risk = (next as { risk?: unknown }).risk;
  return typeof risk === 'string' && (RISK_LEVELS as readonly string[]).includes(risk)
    ? (risk as RiskLevel)
    : null;
}

function readTaskHead(
  db: SqlDatabase,
  dbPath: string,
  render: (task: StoredTask) => string,
): TaskHead {
  const row = pickCandidate(db);
  if (row === null) return { text: null, risk: null, unreadable: null };

  let parsed: StateValue;
  try {
    parsed = JSON.parse(row.state) as StateValue;
  } catch {
    return {
      text: null,
      risk: null,
      unreadable: `task ${row.id} holds a state that is not valid JSON`,
    };
  }
  if (!isPlainObject(parsed)) {
    return { text: null, risk: null, unreadable: `task ${row.id} has no state object` };
  }

  const meta: TaskMeta = {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    path: dbPath,
    skill: row.skill,
    notation: isNotation(row.notation) ? row.notation : DEFAULT_NOTATION,
  };
  const state = parsed as StateDict;
  const task: StoredTask = { meta, state };
  return { text: render(task), risk: riskOf(state), unreadable: null };
}

/**
 * Reads the injection for one state root, without ever writing to it.
 *
 * This is the compiled half of the `inject-state` hook: the hook itself is a standalone
 * script, and reading a SQLite file needs the driver, so it resolves the repository and
 * calls this. Nothing here throws — a hook that fails must cost the turn nothing.
 *
 * Σ is rendered without consulting the skill registry on purpose. A supervising session
 * does not have its worker's skill, and dropping that Σ would hide the exact state the
 * session is trying to resume; the tools still refuse to *patch* what they cannot validate.
 */
export function readInjection(rootDir: string, options: InjectionOptions = {}): Injection {
  const dbPath = join(rootDir, STATE_DB_FILENAME);
  // Checked before opening: without a database there is nothing to read, and reporting
  // "unreadable" here would make the hook warn about a root that is simply empty.
  if (!existsSync(dbPath)) return { kind: 'none' };

  let db: SqlDatabase;
  try {
    // `mustExist` rather than `readOnly`: a read-only connection cannot delete the WAL
    // siblings when it closes, so a hook fired on every prompt would leave state.db-shm
    // and state.db-wal behind in an otherwise at-rest root. This handle runs SELECTs only,
    // and closing it folds the write-ahead log back into the single file.
    db = openStateDatabase(dbPath, { mustExist: true });
  } catch (err) {
    return { kind: 'unreadable', reason: message(err) };
  }

  try {
    const head = readTaskHead(
      db,
      dbPath,
      options.subagent === true ? renderTaskBrief : renderTaskHead,
    );
    if (head.unreadable !== null) return { kind: 'unreadable', reason: head.unreadable };
    const brief = options.brief === true ? renderDatabaseBrief(db) : null;
    if (head.text === null && brief === null) return { kind: 'idle' };
    return { kind: 'context', task: head.text, brief, risk: head.risk };
  } catch (err) {
    return { kind: 'unreadable', reason: message(err) };
  } finally {
    try {
      db.close();
    } catch {
      // A damaged database may not close cleanly; the reason above is the real answer.
    }
  }
}
