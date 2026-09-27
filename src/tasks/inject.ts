import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { projectDirOf } from '../core/paths.js';
import { isPlainObject } from '../core/state.js';
import type { StateDict, StateValue } from '../core/types.js';
import { STATE_DB_FILENAME, openStateDatabase } from '../db/database.js';
import type { SqlDatabase } from '../db/database.js';
import { renderDatabaseBrief } from '../kb/brief.js';
import { driftedArtifacts, driftWarnings, storedArtifactStamps } from './artifact-stamps.js';
import {
  divergedSource,
  divergenceNote,
  migrateLegacyStateRoot,
  rootMigrationNote,
} from './migrate-root.js';
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
   * transcript and usually no state3 tools, so it needs to know a task exists and which step
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
  parent: string | null;
  goal: string;
  status: string;
  /** `rowid`: the insertion order that puts same-millisecond siblings back in queue order. */
  seq: number;
}

const CANDIDATE_COLUMNS =
  'id, skill, notation, state, created_at, updated_at, parent, goal, status, rowid AS seq';

/**
 * The order the injection and the tools agree on: the work in flight, then the queue, then the
 * work that stalled.
 *
 * The queue outranks a blocker because the frontier answers "what can be worked on now", and a
 * blocked task by definition cannot be. Ranking it first meant one task parked for weeks stood
 * in front of every ready piece in the project, which is what a cold session then injected.
 *
 * Mirrors `pickFrontier` in src/tasks/store.ts. The rule lives twice — there as a sort over
 * summaries, here as a query — because a hook runs on every prompt and cannot afford to
 * deserialize every task in the project to find the one it needs. The tiebreak differs by rank
 * for the reason given there: a queued subtask nobody has touched waits behind its older
 * siblings, while a task somebody was in the middle of is found by when it was last touched.
 */
const FRONTIER_ORDER = `CASE status WHEN 'active' THEN 0 WHEN 'pending' THEN 1
              WHEN 'blocked' THEN 2 ELSE 3 END,
         CASE WHEN status = 'pending' THEN created_at END,
         CASE WHEN status = 'pending' THEN rowid END,
         updated_at DESC, id DESC`;

/**
 * The task a hook injects: the piece of open work at the frontier — nothing open underneath it
 * — that the order above picks first.
 *
 * The `NOT EXISTS` is what the tree costs here and what it buys everywhere else: a task that has
 * been split is a container, and injecting it would put the decomposition in the prompt instead
 * of the work, which is the thing splitting it was supposed to stop.
 */
function pickCandidate(db: SqlDatabase): CandidateRow | null {
  const frontier = db
    .prepare(
      `SELECT ${CANDIDATE_COLUMNS} FROM task
       WHERE status <> 'done'
         AND NOT EXISTS (SELECT 1 FROM task AS c WHERE c.parent = task.id AND c.status <> 'done')
       ORDER BY ${FRONTIER_ORDER}
       LIMIT 1`,
    )
    .get() as CandidateRow | undefined;
  if (frontier !== undefined) return frontier;

  // An open task exists but no frontier does: a cycle in `parent`, which is corrupt data rather
  // than anything a sequence of calls can produce. Falling back to the flat answer keeps Σ in
  // the prompt, which is what a session resuming this project needs, and leaves the tree to
  // `doctor` to report.
  const open = db
    .prepare(
      `SELECT ${CANDIDATE_COLUMNS} FROM task
       WHERE status <> 'done'
       ORDER BY ${FRONTIER_ORDER}
       LIMIT 1`,
    )
    .get() as CandidateRow | undefined;
  return open ?? null;
}

/** One row of the branch the task in flight sits on. */
interface BranchRow {
  id: string;
  goal: string;
  status: string;
  parent: string | null;
  created_at: string;
}

/**
 * The chain from the root task down to this one, root first.
 *
 * Walked one query per level rather than loaded whole: a decomposition is a handful of levels
 * deep while a project can hold hundreds of tasks, and this runs on every prompt.
 */
function branchOf(db: SqlDatabase, id: string): BranchRow[] {
  const branch: BranchRow[] = [];
  const seen = new Set<string>();
  let current: string | null = id;
  // `seen` rather than a depth limit: the walk ends at the root in a well-formed tree and at
  // the first repeated id in a corrupt one, and neither needs a constant to be safe.
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const row = db
      .prepare('SELECT id, goal, status, parent, created_at FROM task WHERE id = ?')
      .get(current) as BranchRow | undefined;
    if (row === undefined) break;
    branch.unshift(row);
    current = row.parent;
  }
  return branch;
}

/**
 * How many levels above the task the prompt names, besides the root.
 *
 * The branch line rides on every prompt of the task, so it is the one place where the tree can
 * hand back what splitting work into it just saved. Measured on a chain of 15 levels with
 * sentence-long goals, the uncapped line ran to 1752 chars — 84% of everything the injection
 * carried, against the ~700 chars of Σ it was there to annotate.
 *
 * Depth is the axis that grows without bound, and the two ends of the chain are what a reader
 * needs: the root says which job this is a piece of, the nearest levels say which piece. The
 * middle is navigation, and navigation has its own address — `task_show {"view":"tree"}`. The
 * count is kept so the line still says the chain continues above what is shown.
 */
const BRANCH_NEAREST_LEVELS = 2;

/**
 * The branch line's segments: the root, the levels nearest the task, and a count of what was left
 * out between them.
 *
 * Nothing is elided while the whole chain fits, so a decomposition four levels deep — the shape
 * nearly every tree has — reads in full and the cap costs it nothing.
 */
function branchPath(branch: readonly BranchRow[]): string[] {
  const ancestors = branch.slice(0, -1).map((task) => `${task.goal} [${task.status}]`);
  const [root, ...above] = ancestors;
  if (root === undefined || above.length <= BRANCH_NEAREST_LEVELS) return ancestors;
  const nearest = above.slice(-BRANCH_NEAREST_LEVELS);
  return [root, `… ${above.length - nearest.length} more`, ...nearest];
}

/**
 * The subtasks of the same parent still to come after this one, in the order they were split.
 *
 * Compared on `created_at` and then on `rowid`, which is `queueOrder` in src/tasks/store.ts as
 * SQL: a timestamp has millisecond resolution, and an agent that splits a job into three pieces
 * usually does it inside one millisecond, so the insertion order is what makes "the next one"
 * mean the next one.
 */
function queuedAfter(db: SqlDatabase, row: CandidateRow): BranchRow[] {
  if (row.parent === null) return [];
  return db
    .prepare(
      `SELECT id, goal, status, parent, created_at FROM task
       WHERE parent = ? AND id <> ? AND status <> 'done'
         AND (created_at > ? OR (created_at = ? AND rowid > ?))
       ORDER BY created_at, rowid`,
    )
    .all(row.parent, row.id, row.created_at, row.created_at, row.seq) as BranchRow[];
}

/**
 * Where the task in flight sits in the decomposition, as at most two lines.
 *
 * Splitting work into subtasks is worth exactly what it stops costing: the queue no longer
 * rides along in Σ on every prompt. So what the prompt owes the branch is orientation — which
 * larger job this step belongs to, and that something follows — and not the queue itself.
 * Naming the next sibling is what lets a session that just finished one pick up the following
 * one without spending a call; the rest are a count, because their goals are text no action of
 * this turn reads.
 *
 * `queue` is off for a delegated subagent: it was handed one piece of work and must not start
 * the next one, so telling it what comes next is an invitation it should not be given.
 *
 * Never throws. These lines annotate Σ, and losing the state to a failure in its annotations
 * is the wrong trade — least of all on a prompt where Σ is all the session has.
 */
function branchLines(db: SqlDatabase, row: CandidateRow, queue: boolean): string[] {
  const lines: string[] = [];
  try {
    const branch = branchOf(db, row.id);
    if (branch.length > 1) {
      lines.push(`Branch: ${[...branchPath(branch), 'this task'].join(' -> ')}`);
    }
    if (queue !== true) return lines;

    const queued = queuedAfter(db, row);
    const next = queued[0];
    if (next === undefined) return lines;
    const rest = queued.length - 1;
    lines.push(
      `Queued after this: "${next.goal}" (${next.id})` +
        `${rest === 0 ? '' : ` + ${rest} more`} — task_list prints the tree.`,
    );
  } catch {
    return lines.filter((line) => line.startsWith('Branch:'));
  }
  return lines;
}

/**
 * Open work this injection does not already name, as one line, or null when there is none.
 *
 * The branch and the queue cover the tree the task in flight belongs to, and nothing else: a
 * decomposition under another root is invisible to a session that starts cold, because the
 * frontier picks one task and a parent with open children is a container, never the pick. A cold
 * session that cannot see queued work does not resume it — it starts something new beside it.
 *
 * Session start only, like the artifact drift and for the same reason: a project accumulates open
 * tasks it is not working on (a job blocked last month is open forever), and a line repeated on
 * every prompt would become a permanent tax announcing something that has not changed.
 * `task_list` is one call away for the rest of the session.
 *
 * Siblings are left out of the count: the queue line already names the next one and counts the
 * rest, and naming them twice would only make the number harder to read.
 *
 * Never throws, on the same terms as `branchLines`.
 */
function elsewhereLine(db: SqlDatabase, row: CandidateRow): string | null {
  try {
    const named = new Set(branchOf(db, row.id).map((task) => task.id));
    const open = db.prepare(`SELECT id, parent FROM task WHERE status <> 'done'`).all() as {
      id: string;
      parent: string | null;
    }[];
    const elsewhere = open.filter((task) => {
      if (named.has(task.id)) return false;
      return row.parent === null || task.parent !== row.parent;
    });
    if (elsewhere.length === 0) return null;

    const roots = elsewhere.filter((task) => task.parent === null).length;
    const decompositions = new Set(
      elsewhere.filter((task) => task.parent !== null).map((task) => task.parent),
    );
    const parts: string[] = [];
    if (decompositions.size > 0) {
      parts.push(
        `${elsewhere.length - roots} queued in ${decompositions.size} decomposition` +
          `${decompositions.size === 1 ? '' : 's'}`,
      );
    }
    if (roots > 0) parts.push(`${roots} other open root${roots === 1 ? '' : 's'}`);
    return `Also open elsewhere: ${parts.join(', ')} — task_list prints the tree.`;
  } catch {
    return null;
  }
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
  options: { drift: boolean; queue: boolean },
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
    parent: row.parent,
  };
  const state = parsed as StateDict;
  const task: StoredTask = { meta, state };
  // Above Σ rather than below it: the branch says which piece of a larger job the state below
  // describes, and a resumed session reads top to bottom.
  const branch = branchLines(db, row, options.queue);
  // All three of these are the once-per-session extras, which is what `drift` gates: a surprise
  // reported at a session start costs one line, and repeated on every prompt it costs more than
  // the surprise was worth (§15.5).
  const elsewhere = options.drift ? elsewhereLine(db, row) : null;
  const diverged = options.drift ? divergedSource(rootDir) : null;
  const drift = options.drift ? driftLines(db, row.id, state, rootDir) : [];
  const text = [
    ...branch,
    // Beside the branch and above Σ, because both answer "where does this task sit among the
    // work" and a resumed session reads that before it reads the state itself.
    ...(elsewhere === null ? [] : [elsewhere]),
    render(task),
    // Ahead of the artifact drift: files that moved under Σ are a reason to re-read them, while
    // a second state root still being written is a reason to doubt Σ wholesale.
    ...(diverged === null ? [] : [divergenceNote(diverged)]),
    ...drift,
  ].join('\n');
  return { text, risk: riskOf(state), unreadable: null };
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
 * Carries a pre-rename state root over and returns the line worth reporting, or null.
 *
 * Exported beside `readInjection` because the two standalone halves — the Qwen Code hook and
 * the opencode plugin — both decide whether a root holds a database *before* they call into
 * this build, so neither would reach the carry-over inside `readInjection` on the one run
 * where it matters: the first.
 */
export function carryOverStateRoot(rootDir: string): string | null {
  return rootMigrationNote(migrateLegacyStateRoot(rootDir));
}

/**
 * Reads the injection for one state root, without ever writing to the state it reads.
 *
 * The one thing it does write is the carry-over of a pre-rename root, which copies files into
 * a root that by definition holds no database yet — see `carryOverStateRoot`.
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
  // Before the existence check: a root with no database may still have a pre-rename neighbour
  // holding the project's whole history, and reading that root as empty is what would send a
  // session off to redo finished work.
  const carried = carryOverStateRoot(rootDir);
  const dbPath = join(rootDir, STATE_DB_FILENAME);
  // Checked before opening: without a database there is nothing to read, and reporting
  // "unreadable" here would make the hook warn about a root that is simply empty. A refused
  // carry-over is the exception — the state exists, it only could not be moved, and answering
  // "nothing here" would be the one silently wrong answer this function can give.
  if (!existsSync(dbPath)) {
    return carried === null ? { kind: 'none' } : { kind: 'unreadable', reason: carried };
  }

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
      {
        // Not for a subagent: it gets an orientation rather than Σ, and the artifacts of a task
        // it does not own are context it cannot act on.
        drift: options.drift === true && options.subagent !== true,
        // Nor the queue behind it: a delegated agent was handed one piece of the work and must
        // not start the next one on its own.
        queue: options.subagent !== true,
      },
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
