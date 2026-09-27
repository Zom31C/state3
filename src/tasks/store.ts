import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { gitHead } from '../core/git.js';
import { projectDirOf } from '../core/paths.js';
import type { RejectCategory } from '../core/rejections.js';
import type { Skill } from '../core/skill.js';
import { expandPathPatch, isPlainObject, mergeState } from '../core/state.js';
import type { StateDict, StateValue } from '../core/types.js';
import { validatePatch } from '../core/validator.js';
import { STATE_DB_FILENAME, openStateDatabase } from '../db/database.js';
import type { SqlDatabase } from '../db/database.js';
import { readLegacyRoot } from './legacy.js';
import { migrateLegacyStateRoot, rootMigrationNote } from './migrate-root.js';
import { DEFAULT_NOTATION, isNotation, notationInstructions, NOTATIONS } from './notation.js';
import type { Notation } from './notation.js';
import { composeProcedure } from './procedure.js';
import { builtinSkillRegistry } from './registry.js';
import type { SkillRegistry } from './registry.js';
import { driftedArtifacts, recordArtifactStamps, storedArtifactStamps } from './artifact-stamps.js';
import type { DriftedArtifact } from './artifact-stamps.js';
import {
  LOG_FIELDS,
  decisionsHistoryNote,
  droppedDecisions,
  isLogField,
  logShrinkRefusal,
  wholesaleLogShrink,
} from './decisions.js';
import type { DroppedDecisions, LogField } from './decisions.js';
import { stampHistoryNote, stampVerifications } from './verifications.js';
import type { StampReport } from './verifications.js';

/** A finished task has no next step; its outcome lives in `decisions`. */
const FINISHED_NEXT_ACTION = 'None — task finished; the outcome is the last decisions entry.';

export interface TaskMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** Absolute path of the database file holding this task. */
  path: string;
  /** Skill owning this task's Σ schema, guard and procedure P. */
  skill: string;
  /** How Σ values must be written. */
  notation: Notation;
  /** The task this one was split out of; null for a root task. */
  parent: string | null;
}

export interface StoredTask {
  meta: TaskMeta;
  /** Validated against the task's skill schema on every read. */
  state: StateDict;
}

export interface HistoryEntry {
  at: string;
  /** The patch exactly as the caller sent it, path keys included. */
  patch: StateDict;
  ok: boolean;
  error?: { category: string; message: string };
  /**
   * What an applied patch cost that Σ does not show — the verification stamps it detached.
   * Recorded because the patch alone cannot answer it: an agent is told never to send `at`
   * or `commit`, so the values a patch overwrote exist nowhere else.
   */
  note?: string;
}

/**
 * What a patch did that its caller cannot read back from Σ, filled in by `patch`.
 *
 * An out-parameter rather than a wider return type because a patch has many callers — the
 * tools, the CLI, the tests — and only the tool layer has an answer to put these lines in.
 * A caller that passes nothing gets the same behaviour it always had.
 */
export interface PatchReport {
  /** Verification stamps this patch carried, replaced and detached. */
  stamps?: StampReport;
  /**
   * The move in the tree this patch made, when it made one: the parent the task had and the one
   * it has now, either side null for a root task.
   *
   * Reported for the reason the stamps are: Σ cannot show it. A task's place in the tree is a
   * column, so the state an answer renders reads the same before and after, and a move nobody is
   * told about is how a decomposition gets quietly rearranged.
   */
  moved?: { from: string | null; to: string | null };
  /**
   * The task the queue was handed over to, when this patch closed the one in flight.
   *
   * Reported because the finished task's Σ cannot say it: the handover happened to another row,
   * and a caller that is not told has to spend a read to learn what is in flight now.
   */
  handedOver?: Handover;
  /**
   * The entries the append-only `decisions` log lost to this patch, when it lost any.
   *
   * Reported for the reason the stamps are: after the write Σ holds only what survived, so the
   * answer and the history are the two places the dropped text still exists in.
   */
  dropped?: DroppedDecisions;
}

/** The piece of work the queue moved on to when the one before it was closed. */
export interface Handover {
  id: string;
  goal: string;
}

/** What closing a task did that its own Σ cannot show, filled in by `finish`. */
export interface FinishReport {
  /** The task the queue was handed over to, when closing this one left work at the frontier. */
  handedOver?: Handover;
}

/**
 * What a patch's `parent` key asks the tree for, and whether the tree can take it.
 *
 * A result rather than a throw because a refusal here is recorded in the history like any other:
 * the caller turns it into the same `reject` that a schema failure becomes.
 */
type ReparentResult =
  | { ok: true; from: string | null; to: string | null }
  | { ok: false; category: RejectCategory; message: string };

/**
 * Thrown inside the write transaction when the tree turns out not to allow the move the patch was
 * validated against, so that everything the patch had already written rolls back with it.
 *
 * A throw rather than a returned refusal because the refusal has to be recorded in the history,
 * and a record cannot live inside a write that never happened: the caller catches this outside the
 * transaction and turns it into the same `reject` a failed walk becomes.
 */
class MoveRejectedByTree extends Error {
  /** The task the move was going to be filed under. */
  readonly to: string;

  constructor(to: string) {
    super(`the tree no longer allows a move under ${to}`);
    this.to = to;
  }
}

export interface TaskSummary {
  id: string;
  goal: string;
  status: string;
  skill: string;
  updatedAt: string;
  /**
   * When the task was split out. A tree lists its siblings in the order they were created —
   * that is the order the work was decomposed in, which `updatedAt` scrambles on the first
   * patch of the second one.
   */
  createdAt: string;
  /**
   * Insertion order of the row, as SQLite's `rowid`.
   *
   * The tiebreak the queue cannot do without: `createdAt` has millisecond resolution, and an
   * agent splitting a job into three subtasks lands all three inside one millisecond as often as
   * not. Without this, "the first piece of work" would be decided by the random suffix of an id,
   * which is the same as being decided by nothing.
   */
  seq: number;
  progressDone: number;
  progressTotal: number;
  /** The task this one was split out of; null for a root task. */
  parent: string | null;
  /** How many tasks were split out of this one, and how many of those are not finished. */
  subtasks: number;
  openSubtasks: number;
}

/** What `start` may be asked for beyond the goal. */
export interface StartOptions {
  /** Skill name; defaults to the registry default. */
  skill?: string;
  /** How Σ values must be written; defaults to plain prose. */
  notation?: Notation;
  /** Ordered steps, only for skills whose Σ has a plan array. */
  plan?: readonly string[];
  /**
   * Split this task out of another one: the new task becomes its subtask. Omit it for a root
   * task. The parent must exist and must not be finished — a decomposition nobody is working
   * on any more has no place to file new work under.
   */
  parent?: string;
}

export class TaskNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskNotFoundError';
  }
}

export class TaskPatchError extends Error {
  constructor(
    /** Shared rejection vocabulary, so the tool layer can map it to a hint. */
    public readonly category: RejectCategory,
    message: string,
  ) {
    super(message);
    this.name = 'TaskPatchError';
  }
}

/** One `task` row. `state` is the whole Σ document; the rest are search columns. */
interface TaskRow {
  id: string;
  skill: string;
  notation: string;
  status: string;
  goal: string;
  state: string;
  progress_done: number;
  progress_total: number;
  created_at: string;
  updated_at: string;
  parent: string | null;
  /** `rowid`, selected as `seq`: the insertion order that breaks a same-millisecond tie. */
  seq: number;
}

interface HistoryRow {
  at: string;
  ok: number;
  category: string | null;
  message: string | null;
  patch: string;
}

/**
 * Which of several open tasks is the one to act on: the work in flight, then the queue, then the
 * work that stalled.
 *
 * The queue outranks a blocker because this order answers "what can be worked on now", and a
 * blocked task by definition cannot be. With a blocker first, one task parked for weeks stood in
 * front of every ready piece in the project, and that is what a cold session was handed.
 */
const STATUS_RANK: Readonly<Record<string, number>> = { active: 0, pending: 1, blocked: 2 };

/**
 * The order a decomposition reads in: the order its pieces were split out, with the row's
 * insertion order breaking the tie that a same-millisecond `createdAt` leaves behind.
 *
 * Shared by the listing, the subtree walk and the injection's "what comes next", because a queue
 * that reads in one order and is handed over in another is not a queue.
 */
export function queueOrder(a: TaskSummary, b: TaskSummary): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.seq - b.seq;
}

/**
 * Which of several open tasks is the one to act on, by the rank above.
 *
 * The tiebreak inside a rank differs by what the rank means, and that split is the reason the
 * queue has a rank of its own. A `pending` subtask is one nobody has touched, so it waits behind
 * its older siblings in `queueOrder`: without that, splitting a job into three subtasks would
 * hand back the last one created and leave the first two queued forever. An `active` or `blocked`
 * task is one somebody was in the middle of, so `updatedAt` decides and a resumed session lands
 * back where it stopped.
 */
function pickFrontier(tasks: readonly TaskSummary[]): string | null {
  const open = tasks.filter((task) => task.status !== 'done');
  if (open.length === 0) return null;

  const rank = (task: TaskSummary): number => STATUS_RANK[task.status] ?? 3;
  const ordered = [...open].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    if (a.status === 'pending') {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
      if (a.seq !== b.seq) return a.seq - b.seq;
    } else if (a.updatedAt !== b.updatedAt) {
      return a.updatedAt < b.updatedAt ? 1 : -1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return ordered[0]?.id ?? null;
}

/**
 * Files `taskId` under `to` in one statement, and says whether the tree still allowed it.
 *
 * The walk in `TaskStore.checkReparent` runs before the write transaction, because a refusal has to
 * be recorded in the history and a record cannot live inside a write that never happened. That
 * leaves a window, and two processes on one root — a supervisor addressing it through `project`
 * and the worker itself — both fit inside it: each validates against a tree the other has not yet
 * moved, and between them they close a loop. So the same question is asked again here, inside the
 * write lock and as part of the statement that moves the row: the new parent has to exist and still
 * be open, and the walk up from it has to not meet the task being moved.
 *
 * `false` means the tree disagreed with the validation that let the write start; the caller rolls
 * the whole patch back rather than leave a Σ describing a move that did not happen.
 *
 * `UNION` and not `UNION ALL`, so a loop already in the data — corrupt rows, which `doctor`
 * reports — terminates the recursion instead of feeding it.
 */
export function applyGuardedMove(db: SqlDatabase, to: string, taskId: string): boolean {
  const moved = db
    .prepare(
      `UPDATE task SET parent = ?
       WHERE id = ?
         AND EXISTS (SELECT 1 FROM task WHERE id = ? AND status <> 'done')
         AND NOT EXISTS (
           WITH RECURSIVE above(a) AS (
             SELECT ?
             UNION
             SELECT t.parent FROM task AS t JOIN above ON t.id = above.a
               WHERE t.parent IS NOT NULL
           )
           SELECT 1 FROM above WHERE a = ?
         )`,
    )
    .run(to, taskId, to, to, taskId);
  return moved.changes > 0;
}

/**
 * Task store over the project's single SQLite file.
 *
 * Σ stays one JSON document in the `task` row, because its shape belongs to the
 * task's skill, not to SQL; `status`, `goal` and the progress counters are
 * duplicated into columns only so listing and "which task is active" are queries
 * instead of deserializations. Writes are transactions, so a rejected patch
 * cannot leave the state and its audit trail disagreeing — the failure mode the
 * old two-file layout (JSON plus a JSONL sidecar) could only mitigate by ordering
 * its writes carefully.
 */
export class TaskStore {
  /** Absolute state directory; the tool layer reports it in diagnostics. */
  readonly rootDir: string;

  private readonly skills: SkillRegistry;
  private handle: SqlDatabase | undefined;
  /** Whether the pre-rename root was already looked for; one attempt per store. */
  private rootCarriedOver = false;
  private carryOverNoteLine: string | null = null;

  constructor(rootDir: string, skills: SkillRegistry = builtinSkillRegistry()) {
    this.rootDir = rootDir;
    this.skills = skills;
  }

  /** Absolute path of the database file this store reads and writes. */
  get dbPath(): string {
    return join(this.rootDir, STATE_DB_FILENAME);
  }

  /**
   * Carries a pre-rename state root over, at most once per store, and reports what it did.
   *
   * Runs before the first read as well as the first write: a session that only reads must not
   * conclude the project has no state while its whole history sits in the directory this build
   * no longer looks at by default. The note is kept rather than printed here because a store
   * has no output channel of its own — the tool layer and the CLI decide where it goes.
   */
  private carryOverRoot(): void {
    if (this.rootCarriedOver) return;
    this.rootCarriedOver = true;
    this.carryOverNoteLine = rootMigrationNote(migrateLegacyStateRoot(this.rootDir));
  }

  /** What carrying the pre-rename root over did, for an entry point to report; null if nothing. */
  carryOverNote(): string | null {
    this.carryOverRoot();
    return this.carryOverNoteLine;
  }

  /**
   * The project this root belongs to. The knowledge base borrows it to anchor pages to a
   * commit, and the task store stamps verifications with it: both are facts about the tree,
   * not about the state directory.
   */
  projectDir(): string {
    return projectDirOf(this.rootDir);
  }

  /**
   * The open handle. Shared with the knowledge-base layer so one project costs one
   * connection, not one per concern.
   */
  database(): SqlDatabase {
    if (this.handle === undefined) {
      this.carryOverRoot();
      this.handle = openStateDatabase(this.dbPath);
    }
    return this.handle;
  }

  /**
   * The handle for reads, or null when nothing has ever been stored here. Reads must
   * not create the database: an empty project and a misconfigured state root have to
   * stay distinguishable, and `list()` on a fresh checkout must not leave a file behind.
   * Public because the knowledge base borrows the same connection, and must not create
   * the file either.
   */
  readable(): SqlDatabase | null {
    if (this.handle !== undefined) return this.handle;
    this.carryOverRoot();
    if (!existsSync(this.dbPath)) return null;
    return this.database();
  }

  /** Releases the connection. Safe to call twice; a later call reopens. */
  close(): void {
    if (this.handle === undefined) return;
    this.handle.close();
    this.handle = undefined;
  }

  /** Skills this store can create tasks for; surfaced by the tool layer. */
  skillNames(): string[] {
    return this.skills.names();
  }

  /** Full procedure P for a stored task: its skill's instructions plus the notation appendix. */
  instructionsFor(task: StoredTask): string {
    const skill = this.skills.get(task.meta.skill);
    const notation = notationInstructions(task.meta.notation);
    return skill === undefined ? notation : composeProcedure(skill.instructions, notation);
  }

  private generateId(): string {
    const raw = Math.random().toString(36).slice(2);
    const suffix = (raw + '0000').slice(0, 4);
    return `task-${Date.now().toString(36)}-${suffix}`;
  }

  private skillFor(name: string, taskId: string): Skill {
    const skill = this.skills.get(name);
    if (skill === undefined) {
      throw new TaskPatchError(
        'skill',
        `task ${taskId} names skill "${name}", which this runtime does not have ` +
          `(available: ${this.skills.names().join(', ')})`,
      );
    }
    return skill;
  }

  private rowOrNull(id: string): TaskRow | null {
    const db = this.readable();
    if (db === null) return null;
    const row = db.prepare('SELECT * FROM task WHERE id = ?').get(id);
    return row === undefined ? null : (row as TaskRow);
  }

  private metaOf(row: TaskRow): TaskMeta {
    return {
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      path: this.dbPath,
      skill: row.skill,
      notation: isNotation(row.notation) ? row.notation : DEFAULT_NOTATION,
      parent: row.parent ?? null,
    };
  }

  /**
   * Deserializes and schema-checks a row. A row can only fail here if it was written
   * by a runtime whose skill registry or schema differs from this one — which is a
   * real case (a supervising session supervises a worker on another skill), so it is
   * reported, never silently dropped.
   */
  private toStoredTask(row: TaskRow): StoredTask {
    const skill = this.skillFor(row.skill, row.id);

    let parsedState: StateValue;
    try {
      parsedState = JSON.parse(row.state) as StateValue;
    } catch (err) {
      throw new Error(
        `Task ${row.id} holds a state that is not valid JSON: ${
          err instanceof Error ? err.message : String(err)
        }. The database was changed by hand.`,
      );
    }
    if (!isPlainObject(parsedState)) {
      throw new Error(`Task ${row.id} has no state object; the database was changed by hand.`);
    }

    const parsed = skill.schema.safeParse(parsedState);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue === undefined ? '' : ` at "${issue.path.join('.')}"`;
      const why = issue === undefined ? 'invalid state' : issue.message;
      throw new Error(
        `Task ${row.id} does not satisfy the "${skill.name}" schema${where}: ${why}. ` +
          'It was written by a runtime with a different schema.',
      );
    }
    return { meta: this.metaOf(row), state: parsedState };
  }

  private readTask(id: string): StoredTask {
    const row = this.rowOrNull(id);
    if (row === null) throw new TaskNotFoundError(`No task found with id "${id}"`);
    return this.toStoredTask(row);
  }

  private insertHistory(
    db: SqlDatabase,
    taskId: string,
    at: string,
    patch: StateDict,
    ok: boolean,
    error?: { category: string; message: string },
    note?: string | null,
  ): void {
    db.prepare(
      `INSERT INTO task_history (task_id, at, ok, category, message, patch)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      taskId,
      at,
      ok ? 1 : 0,
      error?.category ?? null,
      // One column, two meanings, told apart by `ok`: a rejection stores its reason, an
      // applied patch stores what it cost. Neither can occur on the same row.
      error?.message ?? note ?? null,
      JSON.stringify(patch),
    );
  }

  /** Writes Σ plus the derived search columns in one statement. */
  private upsert(
    db: SqlDatabase,
    row: {
      id: string;
      skill: string;
      notation: Notation;
      createdAt: string;
      updatedAt: string;
      state: StateDict;
      /**
       * Only read on insert. A Σ write must not move a task in the tree, least of all by
       * omitting a value, so re-filing one is its own statement — see `patch`.
       */
      parent?: string | null;
    },
  ): void {
    const skill = this.skillFor(row.skill, row.id);
    const progress = skill.progress?.(row.state) ?? { done: 0, total: 0 };
    const status = typeof row.state.status === 'string' ? row.state.status : 'unknown';
    const goal = typeof row.state.goal === 'string' ? row.state.goal : '';

    db.prepare(
      `INSERT INTO task (id, skill, notation, status, goal, state, progress_done, progress_total, created_at, updated_at, parent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         skill = excluded.skill,
         notation = excluded.notation,
         status = excluded.status,
         goal = excluded.goal,
         state = excluded.state,
         progress_done = excluded.progress_done,
         progress_total = excluded.progress_total,
         updated_at = excluded.updated_at`,
    ).run(
      row.id,
      row.skill,
      row.notation,
      status,
      goal,
      JSON.stringify(row.state),
      progress.done,
      progress.total,
      row.createdAt,
      row.updatedAt,
      row.parent ?? null,
    );
  }

  async start(goal: string, options: StartOptions = {}): Promise<StoredTask> {
    const skillName = options.skill ?? this.skills.defaultName;
    const skill = this.skills.get(skillName);
    if (skill === undefined) {
      throw new TaskPatchError(
        'skill',
        `unknown skill "${skillName}" (available: ${this.skills.names().join(', ')})`,
      );
    }
    const notation = options.notation ?? DEFAULT_NOTATION;
    if (!isNotation(notation)) {
      throw new TaskPatchError(
        'notation',
        `unknown notation "${String(notation)}" (available: ${NOTATIONS.join(', ')})`,
      );
    }

    const db = this.database();
    const parent = this.checkParent(db, options.parent);

    const state: StateDict = { ...structuredClone(skill.initialState), goal };
    // A subtask is queued, not in flight: the piece of work somebody is on already exists — it
    // is the parent, or the sibling ahead of this one. Two "active" tasks under a decomposition
    // is exactly what made "which Σ do I patch" ambiguous before there was a queue status.
    // A skill whose state has no `status` keeps whatever it started with.
    if (parent !== null && 'status' in state) state.status = 'pending';

    const plan = options.plan;
    const newItem = skill.newPlanItem;
    if (plan !== undefined && plan.length > 0) {
      if (newItem === undefined) {
        throw new TaskPatchError(
          'skill',
          `skill "${skill.name}" takes no plan; start it with a goal, then patch the fields task_show lists`,
        );
      }
      state.plan = plan.map((task, index) => newItem(task, index));
    }

    const parsed = skill.schema.safeParse(state);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new TaskPatchError(
        'schema',
        `skill "${skill.name}" produced an invalid initial state: ${
          issue === undefined ? 'unknown reason' : `${issue.message} at "${issue.path.join('.')}"`
        }`,
      );
    }

    const now = new Date().toISOString();
    // The id is random, so a collision is possible in principle; the primary key
    // turns it into a retry rather than into a silently overwritten task.
    for (;;) {
      const id = this.generateId();
      try {
        db.transaction(() => {
          this.upsert(db, {
            id,
            skill: skill.name,
            notation,
            createdAt: now,
            updatedAt: now,
            state,
            parent,
          });
        });
        return this.readTask(id);
      } catch (err) {
        if (!isUniqueConstraintError(err)) throw err;
      }
    }
  }

  /**
   * The task a new one is filed under, checked.
   *
   * Both refusals say the same thing from two ends: a decomposition is a claim that the parent
   * is still being worked, so filing under a finished one — or under an id that was never a
   * task — would hang the new work off a branch nothing reaches any more.
   */
  private checkParent(db: SqlDatabase, parent: string | undefined): string | null {
    const requested = normalizeParent(parent);
    if (requested === null) return null;
    const row = this.parentRowOrNull(db, requested);
    if (row === null) throw new TaskPatchError('guard', splitRefusal(requested, 'missing'));
    if (row.status === 'done') throw new TaskPatchError('guard', splitRefusal(requested, 'done'));
    return requested;
  }

  /**
   * The row a requested parent names, or null when no task has that id.
   *
   * One lookup for both writes that file a task under another one — `start`, and a patch carrying
   * `parent` — with no opinion of its own: what a missing or a finished parent means differs by
   * direction, and a move has one more thing to check first (see `checkReparent`).
   */
  private parentRowOrNull(db: SqlDatabase, id: string): { id: string; status: string } | null {
    const row = db.prepare('SELECT id, status FROM task WHERE id = ?').get(id) as
      { id: string; status: string } | undefined;
    return row ?? null;
  }

  /**
   * What a patch's `parent` asks the tree for, checked against the tree.
   *
   * These are the refusals no skill guard can make: a guard reads one state, and the shape of
   * the decomposition lives in other rows. The cycle is the one that matters — every reader
   * walks the branch (the injection, the listing, `activeId`), so a loop degrades all of them at
   * once, and it would be reachable by a legal call instead of only by a hand-edited database.
   *
   * The task keeps its status and its own subtasks: a move re-files the piece where it belongs,
   * it does not restart it, and demoting work in flight to `pending` would hand the frontier to
   * a sibling the caller said nothing about.
   */
  private checkReparent(
    db: SqlDatabase,
    taskId: string,
    currentParent: string | null,
    requested: StateValue,
  ): ReparentResult {
    let to: string | null;
    if (requested === null) to = null;
    else if (typeof requested === 'string') to = normalizeParent(requested);
    else {
      return {
        ok: false,
        category: 'type-coercion',
        message:
          '"parent" moves this task in the tree, so it takes a task id, or null to make it a ' +
          `root task — not ${kindOfValue(requested)}`,
      };
    }
    if (to === currentParent) return { ok: true, from: currentParent, to };
    if (to === null) return { ok: true, from: currentParent, to };
    if (to === taskId) {
      return { ok: false, category: 'guard', message: `task ${taskId} cannot be its own parent` };
    }

    const parentRow = this.parentRowOrNull(db, to);
    if (parentRow === null) {
      return { ok: false, category: 'guard', message: moveRefusal(to, 'missing') };
    }

    // Walked up from the new parent rather than down from this task: the branch above is a
    // handful of rows while a decomposition can be wide, and the first step that meets this
    // task's id is the loop the move would close.
    const seen = new Set<string>();
    let cursor: string | null = to;
    while (cursor !== null) {
      if (cursor === taskId) {
        return {
          ok: false,
          category: 'guard',
          message:
            `task ${to} already sits under ${taskId}, so moving this one there would make it ` +
            'its own ancestor',
        };
      }
      if (seen.has(cursor)) {
        return {
          ok: false,
          category: 'guard',
          message:
            `the parents above task ${to} loop back on themselves — the tree is corrupt, so ` +
            'nothing can be filed under it until that is fixed',
        };
      }
      seen.add(cursor);
      const above = db.prepare('SELECT parent FROM task WHERE id = ?').get(cursor) as
        { parent: string | null } | undefined;
      cursor = above?.parent ?? null;
    }

    // Last, so the loop above wins the wording: a finished *descendant* of this task is refused
    // either way, and "move it under an open task instead" is advice that cannot work for any of
    // them. Naming the loop is the only refusal here that tells the caller the truth.
    if (parentRow.status === 'done') {
      return { ok: false, category: 'guard', message: moveRefusal(to, 'done') };
    }
    return { ok: true, from: currentParent, to };
  }

  /**
   * Subtasks of a task that are not finished.
   *
   * The one number that decides both whether a task is the frontier of the work and whether it
   * may be closed: a decomposition whose pieces are still open is not finished, whatever its
   * own Σ says, and it is not where the next action is either.
   */
  private openChildCount(db: SqlDatabase, taskId: string): number {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM task WHERE parent = ? AND status <> 'done'`)
      .get(taskId) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /**
   * Promotes the task the queue moves on to when `closedId` closes, and says who it was.
   *
   * The handover used to be advice — "set the next piece `active` in the same patch that closes
   * this one" — and advice is not a mechanism: a session that closes a piece and stops leaves the
   * next one `pending`, so `task_list` shows the work in flight as still queued, and the invariant
   * `start` keeps (one piece in flight per decomposition) holds only for as long as everybody
   * remembers the advice.
   *
   * Called inside the transaction that closes the task, so the tree is never observed with a
   * decomposition that has work left and nothing in flight.
   *
   * Skips three cases. Another piece of the same decomposition is already `active`: somebody took
   * the next one by hand, and promoting a second is exactly the ambiguity `pending` exists to
   * prevent. The next piece is `blocked`: promoting it would erase the signal that it is waiting on
   * something, and the frontier already ranks a ready piece above it, so the queue is not stuck.
   * Its Σ cannot be read by this runtime — a foreign skill, a state written by another schema —
   * which is a reason to leave the status alone, not a reason to fail the close that was asked for.
   */
  private handOver(db: SqlDatabase, closedId: string, now: string): Handover | null {
    const closed = db.prepare('SELECT parent FROM task WHERE id = ?').get(closedId) as
      { parent: string | null } | undefined;
    const parent = closed?.parent ?? null;
    if (parent === null) return null;

    const busy = db
      .prepare(`SELECT 1 FROM task WHERE parent = ? AND status = 'active' AND id <> ?`)
      .get(parent, closedId);
    if (busy !== undefined) return null;

    // The pieces still queued, in the order the work was split out — `queueOrder` as SQL. The
    // first one this runtime can validate is the work in flight from here on; a piece written by
    // a skill it does not have stays queued for the runtime that can read it, and the frontier
    // skips that one too, since `list()` cannot summarize a row it cannot parse.
    const queue = db
      .prepare(
        `SELECT id, goal FROM task WHERE parent = ? AND status = 'pending' AND id <> ?
         ORDER BY created_at, rowid`,
      )
      .all(parent, closedId) as { id: string; goal: string }[];
    for (const candidate of queue) {
      const promoted = this.promote(db, candidate, closedId, now);
      if (promoted !== null) return promoted;
    }

    // Nothing left in the queue: the work returns to the task that was split, which is the
    // frontier now that nothing under it is open. A root is created `active`, so this is about a
    // decomposition nested inside one — the level whose pieces somebody just finished.
    if (this.openChildCount(db, parent) > 0) return null;
    const container = db.prepare('SELECT id, goal, status FROM task WHERE id = ?').get(parent) as
      { id: string; goal: string; status: string } | undefined;
    if (container === undefined || container.status !== 'pending') return null;
    return this.promote(db, container, closedId, now);
  }

  /**
   * Writes `status: "active"` to a task the queue handed over, recording why in its history, or
   * null when its Σ cannot be read and validated by this runtime.
   */
  private promote(
    db: SqlDatabase,
    task: { id: string; goal: string },
    closedId: string,
    now: string,
  ): Handover | null {
    try {
      const row = this.rowOrNull(task.id);
      if (row === null) return null;
      const skill = this.skills.get(row.skill);
      if (skill === undefined) return null;
      const parsedState = JSON.parse(row.state) as StateValue;
      if (!isPlainObject(parsedState)) return null;
      const state: StateDict = { ...parsedState, status: 'active' };
      if (!skill.schema.safeParse(state).success) return null;

      this.upsert(db, {
        id: row.id,
        skill: row.skill,
        notation: isNotation(row.notation) ? row.notation : DEFAULT_NOTATION,
        createdAt: row.created_at,
        updatedAt: now,
        state,
      });
      // Recorded in the promoted task's own history: an audit of "why is this active" that reads
      // only the state would come up empty, since the patch that did it was nobody's.
      this.insertHistory(
        db,
        row.id,
        now,
        { status: 'active' },
        true,
        undefined,
        `promoted by the runtime when ${closedId} was closed: next in the queue`,
      );
      return { id: row.id, goal: task.goal };
    } catch {
      return null;
    }
  }

  async show(id?: string): Promise<StoredTask> {
    if (id !== undefined) return this.readTask(id);
    const activeId = await this.activeId();
    if (activeId === null) throw new TaskNotFoundError('No active task found');
    return this.readTask(activeId);
  }

  /**
   * Applies a patch to Σ. `report`, when given, is filled with what the write cost that Σ
   * itself does not show — see `PatchReport`.
   *
   * One key addresses the tree instead of the state: `parent` re-files this task under another
   * one, or under nothing, and is validated against the tree rather than against the skill's
   * schema — see `checkReparent`.
   *
   * `confirm` names the append-only logs this patch means to rewrite wholesale — see
   * `wholesaleLogShrink` for what is refused without it.
   */
  async patch(
    patch: StateDict,
    id?: string,
    report?: PatchReport,
    confirm?: readonly string[],
  ): Promise<StoredTask> {
    const taskId = id ?? (await this.activeId());
    if (taskId === null) throw new TaskNotFoundError('No active task found');

    const row = this.rowOrNull(taskId);
    if (row === null) throw new TaskNotFoundError(`No task found with id "${taskId}"`);
    const skill = this.skillFor(row.skill, taskId);

    let state: StateDict;
    try {
      const parsedState = JSON.parse(row.state) as StateValue;
      if (!isPlainObject(parsedState)) throw new Error('state is not an object');
      state = parsedState;
    } catch {
      throw new Error(`Task ${taskId} has no state object; the database was changed by hand.`);
    }

    const db = this.database();
    const now = new Date().toISOString();

    // A rejected patch stays in the history: the audit trail includes what did not apply.
    const reject = (category: RejectCategory, message: string): never => {
      this.insertHistory(db, taskId, now, patch, false, { category, message });
      throw new TaskPatchError(category, message);
    };

    // `parent` addresses the tree rather than Σ: a task's place in the decomposition is a
    // column, and no skill schema has the field. Taken out before validation so the strict
    // schema never sees it — the "unknown key" it would answer with is exactly the refusal this
    // replaces — and written in the same transaction below, so a patch either moves the task and
    // records the move, or does neither.
    //
    // A key that is there with no value means "no opinion", not "detach": an in-process caller
    // spreading an absent option produces one, and reading it as `null` would move a task nobody
    // asked to move.
    const statePatch: StateDict = { ...patch };
    const requestedParent = statePatch.parent;
    delete statePatch.parent;

    // Path keys ("plan[1].status") are expanded before the guard runs, so domain
    // rules see the same wholesale shape they were written against.
    const expanded = expandPathPatch(state, statePatch);
    if (!expanded.ok) return reject('path', expanded.message);

    const validation = validatePatch(skill, state, expanded.patch);
    if (!validation.ok) return reject(validation.category, validation.message);

    const merged = mergeState(state, expanded.patch);

    // Ahead of the stamps and of every other guard: this one is about entries the write would
    // destroy, so it must be the first thing that can stop it, and a patch it refuses must not
    // have spawned the git subprocess that stamps verifications.
    const confirmed: LogField[] = [];
    for (const field of confirm ?? []) {
      if (!isLogField(field)) {
        return reject(
          'guard',
          `confirm names "${String(field)}"; the append-only logs are: ${LOG_FIELDS.join(', ')}`,
        );
      }
      confirmed.push(field);
    }
    const shrinks = wholesaleLogShrink(state, statePatch, merged).filter(
      (shrink) => !confirmed.includes(shrink.field),
    );
    if (shrinks.length > 0) return reject('guard', logShrinkRefusal(shrinks));

    // A decomposition is not finished while its pieces are open, whatever its own Σ says. The
    // skill guard cannot see this — it reads one state, and the subtasks are other rows — and
    // closing a parent early is what leaves work orphaned: every view that picks a task to
    // inject walks the tree, so a finished parent hides the open branch under it.
    const closesNow = merged.status === 'done' && state.status !== 'done';
    if (closesNow) {
      const open = this.openChildCount(db, taskId);
      if (open > 0) {
        return reject(
          'guard',
          `task ${taskId} has ${open} open subtask(s); finish or skip them before closing it`,
        );
      }
    }

    // The other rule the skill guard cannot make, on the same grounds: where this task sits is
    // a column, and whether the move closes a loop is a question about other rows.
    let moved: { from: string | null; to: string | null } | null = null;
    let handedOver: Handover | null = null;
    if (requestedParent !== undefined) {
      const checked = this.checkReparent(db, taskId, row.parent ?? null, requestedParent);
      if (!checked.ok) return reject(checked.category, checked.message);
      moved = { from: checked.from, to: checked.to };
    }
    const didMove = moved !== null && moved.from !== moved.to;

    // A root is never queued: `pending` is a place in a queue, and nothing hands a root over. A
    // piece detached from its decomposition therefore becomes work in flight — which is how the
    // frontier already treated it, since a queued task ranks as ready — rather than being refused,
    // because the move itself is the sensible thing to do and only the status left over from it is
    // not. Said in the note: the patch as sent does not mention a status change.
    let promotedOutOfQueue = false;
    if (didMove && moved !== null && moved.to === null && merged.status === 'pending') {
      merged.status = 'active';
      promotedOutOfQueue = true;
    }

    // Refused here rather than in the skill guard, which reads one state and cannot see the column
    // that decides it — and only when this patch is what puts the two together, so a row that got
    // into the shape some other way can still be patched out of it.
    const parentAfter = moved === null ? (row.parent ?? null) : moved.to;
    if (parentAfter === null && merged.status === 'pending' && state.status !== 'pending') {
      return reject(
        'guard',
        'a root task cannot be "pending": nothing queues it, so no runtime would ever hand it ' +
          'over. Set it "active" to take the work up, "blocked" if it is waiting on something, or ' +
          'file it under a task with {"parent": "<task id>"}.',
      );
    }

    // Stamped before validation, so the stamps are checked like everything else the write
    // produces, and before the transaction, so a refused patch spawns no git subprocess.
    const stamps = stampVerifications(state, merged, () => ({
      at: now,
      commit: gitHead(projectDirOf(this.rootDir)),
    }));
    // The other thing a write can cost that Σ cannot show afterwards: entries the append-only log
    // had and the merged array no longer does.
    const dropped = droppedDecisions(state, merged);
    const parsed = skill.schema.safeParse(merged);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue === undefined ? '' : ` at "${issue.path.join('.')}"`;
      const why = issue === undefined ? 'unknown reason' : issue.message;
      return reject('schema', `State validation failed${where}: ${why}`);
    }

    // Written before the transaction so a patch that the schema then refuses leaves no
    // note behind: nothing was superseded by a write that never happened.
    const notes = [
      didMove ? moveNote(moved) : null,
      promotedOutOfQueue ? 'a root task cannot stay queued, so its status became "active"' : null,
      stampHistoryNote(stamps),
      decisionsHistoryNote(dropped),
    ].filter((line): line is string => line !== null);
    const note = notes.length === 0 ? null : notes.join('; ');

    try {
      db.transaction(() => {
        this.upsert(db, {
          id: taskId,
          skill: row.skill,
          notation: isNotation(row.notation) ? row.notation : DEFAULT_NOTATION,
          createdAt: row.created_at,
          updatedAt: now,
          state: merged,
        });
        if (didMove && moved !== null) {
          // Its own statement: `upsert` leaves the row's place in the tree alone on conflict, so
          // that a Σ write cannot move a task by omission, and so the move is visible here as the
          // one thing this patch did to the tree. Guarded in SQL when it names a parent, because
          // the walk that allowed the move read the tree before this transaction began.
          if (moved.to === null) {
            db.prepare('UPDATE task SET parent = NULL WHERE id = ?').run(taskId);
          } else if (!applyGuardedMove(db, moved.to, taskId)) {
            throw new MoveRejectedByTree(moved.to);
          }
        }
        // The patch is recorded as sent: the history shows what the agent asked for,
        // which is what an audit of a rejected or surprising patch needs. The note carries what the
        // write cost and the patch cannot show — the stamps it detached, the log entries it
        // dropped, the place in the tree it moved the task to.
        this.insertHistory(db, taskId, now, patch, true, undefined, note);
        // Closing a task by patch hands the queue over exactly as `finish` does: the two are the
        // same event, and a mechanism that only one of them has is a mechanism an agent has to
        // remember to use the other way round.
        if (closesNow) handedOver = this.handOver(db, taskId, now);
        // Σ was just written, so this is the moment its file artifacts are true of the tree;
        // a later read compares the disk against what was recorded here.
        recordArtifactStamps(db, taskId, merged, projectDirOf(this.rootDir), now);
      });
    } catch (err) {
      if (!(err instanceof MoveRejectedByTree)) throw err;
      // Rolled back, so nothing was written and the refusal can still be recorded outside the
      // write that never happened. The walk is repeated to name the rule the tree now disagrees
      // on: a refusal that says only "the tree changed" leaves the caller guessing at which half
      // of the move was wrong.
      const rechecked =
        requestedParent === undefined
          ? null
          : this.checkReparent(db, taskId, row.parent ?? null, requestedParent);
      if (rechecked !== null && !rechecked.ok) return reject(rechecked.category, rechecked.message);
      return reject(
        'guard',
        `the tree changed while task ${taskId} was being moved under ${err.to}, so nothing was ` +
          'written; task_show {"view":"tree"} prints the tree as it stands now',
      );
    }

    if (report !== undefined) {
      report.stamps = stamps;
      if (didMove && moved !== null) report.moved = moved;
      if (dropped !== null) report.dropped = dropped;
      if (handedOver !== null) report.handedOver = handedOver;
    }
    return this.readTask(taskId);
  }

  /**
   * The file artifacts of a task whose file is no longer what Σ was written against.
   *
   * Read from the raw row rather than through `readTask`: this is a diagnostic about the
   * tree, and it has to answer for a Σ this build cannot validate too — a foreign skill's
   * state is exactly the one a supervising session may be looking at.
   */
  async driftedArtifacts(id?: string): Promise<DriftedArtifact[]> {
    const taskId = id ?? (await this.activeId());
    if (taskId === null) return [];
    const db = this.readable();
    if (db === null) return [];
    const row = this.rowOrNull(taskId);
    if (row === null) return [];

    let parsed: StateValue;
    try {
      parsed = JSON.parse(row.state) as StateValue;
    } catch {
      return [];
    }
    if (!isPlainObject(parsed)) return [];

    return driftedArtifacts(parsed, storedArtifactStamps(db, taskId), projectDirOf(this.rootDir));
  }

  /**
   * Closes a task, and hands the queue over to the piece behind it in the same transaction.
   * `report`, when given, is filled with that handover — see `FinishReport`.
   */
  async finish(summary: string, id?: string, report?: FinishReport): Promise<StoredTask> {
    const taskId = id ?? (await this.activeId());
    if (taskId === null) throw new TaskNotFoundError('No active task found');

    // The same rule patch() enforces, on the path that exists to close a task: finishing a
    // decomposition while its pieces are open is how work disappears from every tree view.
    const openChildren = this.openChildCount(this.database(), taskId);
    if (openChildren > 0) {
      throw new TaskPatchError(
        'guard',
        `task ${taskId} has ${openChildren} open subtask(s); finish or skip them before closing it`,
      );
    }

    const task = this.readTask(taskId);
    const skill = this.skillFor(task.meta.skill, taskId);
    const now = new Date().toISOString();

    // Every task skill carries the same closing contract: a status, an
    // append-only decisions log, and a next step. That is what makes one
    // finish() correct for all of them.
    const current = task.state.decisions;
    const decisions: StateValue[] = Array.isArray(current) ? [...current, summary] : [summary];
    const state: StateDict = {
      ...task.state,
      status: 'done',
      decisions,
      next: { action: FINISHED_NEXT_ACTION, risk: 'safe' },
    };

    const parsed = skill.schema.safeParse(state);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new TaskPatchError(
        'schema',
        `finishing would break the "${skill.name}" schema: ${
          issue === undefined ? 'unknown reason' : issue.message
        }`,
      );
    }

    const db = this.database();
    let handedOver: Handover | null = null;
    db.transaction(() => {
      this.upsert(db, {
        id: taskId,
        skill: task.meta.skill,
        notation: task.meta.notation,
        createdAt: task.meta.createdAt,
        updatedAt: now,
        state,
      });
      this.insertHistory(
        db,
        taskId,
        now,
        {
          status: 'done',
          decisions,
          next: { action: FINISHED_NEXT_ACTION, risk: 'safe' },
        },
        true,
      );
      handedOver = this.handOver(db, taskId, now);
    });

    if (report !== undefined && handedOver !== null) report.handedOver = handedOver;
    return this.readTask(taskId);
  }

  async list(): Promise<TaskSummary[]> {
    const db = this.readable();
    if (db === null) {
      // An empty root and an un-migrated one must not look the same: the second still holds
      // the project's whole task history on disk, in the layout this build no longer reads.
      // Reporting "no tasks" there would send an agent off to redo work that already exists.
      const legacy = await readLegacyRoot(this.rootDir);
      if (legacy.records.length > 0) {
        throw new Error(
          `this state root holds ${legacy.records.length} task record(s) in the legacy JSON ` +
            `layout and has no database: run \`state3 task migrate --root ${this.rootDir}\``,
        );
      }
      return [];
    }

    const rows = db
      .prepare('SELECT *, rowid AS seq FROM task ORDER BY updated_at DESC, id DESC')
      .all() as TaskRow[];

    // Counted from the rows rather than from the summaries: a subtask whose Σ this runtime
    // cannot validate is still a piece of open work, and leaving it out of the count is what
    // would let its parent look finished and get closed over it.
    const subtasks = new Map<string, { total: number; open: number }>();
    for (const row of rows) {
      if (row.parent === null) continue;
      const entry = subtasks.get(row.parent) ?? { total: 0, open: 0 };
      entry.total += 1;
      if (row.status !== 'done') entry.open += 1;
      subtasks.set(row.parent, entry);
    }

    const summaries: TaskSummary[] = [];
    for (const row of rows) {
      // A row from a foreign schema must not break the list: a session supervising
      // another project has that project's skills, not this one's.
      try {
        const skill = this.skillFor(row.skill, row.id);
        const parsedState = JSON.parse(row.state) as StateValue;
        if (!isPlainObject(parsedState)) continue;
        if (!skill.schema.safeParse(parsedState).success) continue;
        const progress = skill.progress?.(parsedState) ?? { done: 0, total: 0 };
        const split = subtasks.get(row.id);
        summaries.push({
          id: row.id,
          goal: row.goal,
          status: row.status,
          skill: skill.name,
          updatedAt: row.updated_at,
          createdAt: row.created_at,
          seq: row.seq,
          progressDone: progress.done,
          progressTotal: progress.total,
          parent: row.parent ?? null,
          subtasks: split?.total ?? 0,
          openSubtasks: split?.open ?? 0,
        });
      } catch {
        continue;
      }
    }

    return summaries;
  }

  async history(id?: string, limit?: number): Promise<HistoryEntry[]> {
    const taskId = id ?? (await this.activeId());
    if (taskId === null) throw new TaskNotFoundError('No active task found');

    const db = this.readable();
    if (db === null) return [];

    const effectiveLimit = limit ?? 20;
    const rows = db
      .prepare(
        `SELECT at, ok, category, message, patch FROM task_history
         WHERE task_id = ? ORDER BY seq DESC LIMIT ?`,
      )
      .all(taskId, effectiveLimit) as HistoryRow[];

    // Selected newest-first for the LIMIT, returned oldest-first like the old JSONL tail.
    const entries: HistoryEntry[] = [];
    for (const row of rows.reverse()) {
      let patch: StateDict;
      try {
        const parsed = JSON.parse(row.patch) as StateValue;
        if (!isPlainObject(parsed)) continue;
        patch = parsed;
      } catch {
        continue;
      }
      const entry: HistoryEntry = { at: row.at, patch, ok: row.ok !== 0 };
      if (row.category !== null && row.message !== null) {
        entry.error = { category: row.category, message: row.message };
      } else if (row.message !== null) {
        entry.note = row.message;
      }
      entries.push(entry);
    }
    return entries;
  }

  /**
   * The task the tools act on when no id is given: the most recently updated piece of work
   * that is actually at the frontier — open, and with nothing open underneath it.
   *
   * The second half is what the tree costs and what it buys. A task that has been split is a
   * container: naming it would answer "which Σ do I patch" with the decomposition instead of
   * the step in flight, and would inject the queue rather than the work. A `blocked` task
   * still counts as open — an agent that has just reported a blocker must be able to patch its
   * way out of it without first looking the id up with task_list.
   */
  async activeId(): Promise<string | null> {
    const all = await this.list();
    const frontier = all.filter((s) => s.status !== 'done' && s.openSubtasks === 0);
    const atFrontier = pickFrontier(frontier);
    if (atFrontier !== null) return atFrontier;
    // Only reachable on a cycle in `parent`, which is corrupt data rather than a state any
    // sequence of calls can produce. Falling back to the flat answer keeps the tools usable
    // and leaves `doctor` to report the tree.
    return pickFrontier(all);
  }

  /**
   * The branch from the root task down to this one, root first.
   *
   * What a prompt carries instead of the whole decomposition: the goals above the work in
   * flight, one line each, are enough to know which piece of a larger job this is.
   */
  async branchOf(id: string): Promise<TaskSummary[]> {
    const all = await this.list();
    const byId = new Map(all.map((task) => [task.id, task]));
    const branch: TaskSummary[] = [];
    const seen = new Set<string>();
    let current = byId.get(id);
    // `seen` rather than a depth limit: the walk terminates on the root in a well-formed tree,
    // and on the first repeated id in a corrupt one.
    while (current !== undefined && !seen.has(current.id)) {
      seen.add(current.id);
      branch.unshift(current);
      current = current.parent === null ? undefined : byId.get(current.parent);
    }
    return branch;
  }

  /**
   * Every task under this one, each before its own children, siblings in the order they were
   * split out. The whole decomposition, which is what a listing wants and a prompt does not.
   */
  async subtreeOf(id: string): Promise<TaskSummary[]> {
    const all = await this.list();
    const byParent = new Map<string, TaskSummary[]>();
    for (const task of all) {
      if (task.parent === null) continue;
      const siblings = byParent.get(task.parent) ?? [];
      siblings.push(task);
      byParent.set(task.parent, siblings);
    }
    for (const siblings of byParent.values()) siblings.sort(queueOrder);

    const out: TaskSummary[] = [];
    const seen = new Set<string>([id]);
    const walk = (parentId: string): void => {
      for (const child of byParent.get(parentId) ?? []) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        out.push(child);
        walk(child.id);
      }
    };
    walk(id);
    return out;
  }

  /**
   * The subtasks that come after this one under the same parent, in the order they were split
   * out — the queue a prompt owes one line about, and no more than one line.
   */
  async laterSiblingsOf(id: string): Promise<TaskSummary[]> {
    const branch = await this.branchOf(id);
    const task = branch[branch.length - 1];
    if (task === undefined || task.parent === null) return [];
    const siblings = (await this.subtreeOf(task.parent)).filter((s) => s.parent === task.parent);
    return siblings.filter((s) => s.id !== id && queueOrder(s, task) > 0);
  }

  /** True when a task with this id is already stored. */
  has(id: string): boolean {
    const db = this.readable();
    if (db === null) return false;
    return db.prepare('SELECT 1 FROM task WHERE id = ?').get(id) !== undefined;
  }

  /**
   * Writes a record verbatim — id, timestamps, skill and Σ exactly as given, with no
   * validation and no generated id. This is the migration entry point: a record that
   * this runtime cannot interpret is still worth preserving, and re-validating it here
   * would turn "migrate what the previous version wrote" into "lose what we cannot read".
   */
  importRecord(record: {
    id: string;
    skill: string;
    notation: string;
    createdAt: string;
    updatedAt: string;
    state: StateDict;
  }): void {
    const db = this.database();
    const status = typeof record.state.status === 'string' ? record.state.status : 'unknown';
    const goal = typeof record.state.goal === 'string' ? record.state.goal : '';
    // Progress stays 0/0 for a skill this runtime does not have; a readable one is
    // recomputed from Σ so the counters cannot disagree with the state.
    const skill = this.skills.get(record.skill);
    const progress = skill?.progress?.(record.state) ?? { done: 0, total: 0 };

    db.prepare(
      `INSERT INTO task (id, skill, notation, status, goal, state, progress_done, progress_total, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.id,
      record.skill,
      record.notation,
      status,
      goal,
      JSON.stringify(record.state),
      progress.done,
      progress.total,
      record.createdAt,
      record.updatedAt,
    );
  }

  /** Appends audit entries in the given order, so `seq` reproduces the JSONL chronology. */
  importHistory(id: string, entries: readonly HistoryEntry[]): void {
    const db = this.database();
    db.transaction(() => {
      for (const entry of entries) {
        this.insertHistory(
          db,
          id,
          entry.at,
          entry.patch,
          entry.ok,
          entry.ok
            ? undefined
            : {
                category: entry.error?.category ?? 'error',
                message: entry.error?.message ?? 'unknown reason',
              },
        );
      }
    });
  }
}

/** True when the driver rejected a duplicate primary key, which is what an id collision looks like. */
function isUniqueConstraintError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || code === 'SQLITE_CONSTRAINT_UNIQUE';
}

/**
 * A requested parent as an id, or null for "no parent".
 *
 * An empty string means the same thing in both directions — splitting a task out of nothing and
 * moving one out of its decomposition — because the callers spell "none" however their payload
 * happens to allow, and the tree has one answer.
 */
function normalizeParent(parent: string | undefined | null): string | null {
  if (parent === undefined || parent === null) return null;
  const id = parent.trim();
  return id === '' ? null : id;
}

/** Why an id cannot hold a new subtask, worded for `start`. */
function splitRefusal(id: string, reason: 'missing' | 'done'): string {
  return reason === 'missing'
    ? `no task with id "${id}" to split this one out of`
    : `task ${id} is done, so it takes no new subtasks; start a root task instead`;
}

/** Why an id cannot take an existing task, worded for a move. */
function moveRefusal(id: string, reason: 'missing' | 'done'): string {
  return reason === 'missing'
    ? `no task with id "${id}" to move this one under`
    : `task ${id} is done, so it takes no new subtasks; move this one under an open task, ` +
        'or send {"parent": null} to make it a root task';
}

/** A value a refusal names as the kind of thing it is, rather than as its JSON. */
function kindOfValue(value: StateValue): string {
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value}`;
}

/**
 * What a move in the tree reads like in the audit trail, or null when nothing moved.
 *
 * The history stores the patch as sent, which does name the new parent — but not the old one, so
 * the entry alone cannot answer where the task came from, and "where did this decomposition's
 * shape come from" is exactly what an audit of a tree asks.
 */
function moveNote(move: { from: string | null; to: string | null } | null): string | null {
  if (move === null || move.from === move.to) return null;
  if (move.to === null) return `moved out of ${move.from ?? 'the tree'} into a root task`;
  if (move.from === null) return `filed under ${move.to}, was a root task`;
  return `moved from ${move.from} under ${move.to}`;
}
