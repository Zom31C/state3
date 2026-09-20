import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { projectDirOf } from '../core/paths.js';
import { isPlainObject } from '../core/state.js';
import type { StateDict, StateValue } from '../core/types.js';
import { STATE_DB_FILENAME, openStateDatabase } from '../db/database.js';
import type { SqlDatabase } from '../db/database.js';
import { renderDatabaseBrief } from '../kb/brief.js';
import { driftedArtifacts, driftWarnings, storedArtifactStamps } from './artifact-stamps.js';
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
  /**
   * Also compare the task's file artifacts against the disk and say which of them moved.
   *
   * A session start asks for this and a prompt does not: it is the moment the transcript holds
   * nothing, so a tree changed by hand between sessions is otherwise invisible, and Σ reads as
   * an account of the tree as it is now. Repeating the same line on every prompt of the session
   * would cost more than the surprise is worth — the session has already been told once.
   */
  drift?: boolean;
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
  rootDir: string,
  render: (task: StoredTask) => string,
  drift: boolean,
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
  const lines = drift ? driftLines(db, row.id, state, rootDir) : [];
  const text = render(task);
  return {
    text: lines.length === 0 ? text : `${text}\n${lines.join('\n')}`,
    risk: riskOf(state),
    unreadable: null,
  };
}

/**
 * The artifacts whose file moved since Σ was written, as lines for the injection.
 *
 * Never throws. A drift note is a convenience on top of Σ, and a diagnostic that fails must
 * not cost the turn the state it was annotating — least of all at a session start, where Σ
 * is the only thing the session has.
 */
function driftLines(db: SqlDatabase, taskId: string, state: StateDict, rootDir: string): string[] {
  try {
    return driftWarnings(
      driftedArtifacts(state, storedArtifactStamps(db, taskId), projectDirOf(rootDir)),
    );
  } catch {
    return [];
  }
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
      rootDir,
      options.subagent === true
        ? renderTaskBrief
        : // A prompt is not a read: it carries Σ on every turn of the task, so it drops the
          // archived steps and, above the threshold, everything but the step in flight.
          (task) => renderTaskHead(task, { injected: true }),
      // Not for a subagent: it gets an orientation rather than Σ, and the artifacts of a task
      // it does not own are context it cannot act on.
      options.drift === true && options.subagent !== true,
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
