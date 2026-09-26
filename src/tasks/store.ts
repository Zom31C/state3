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
 * Which of several open tasks is the one to act on: the work in flight, then the work that
 * stalled, then the queue behind it.
 */
const STATUS_RANK: Readonly<Record<string, number>> = { active: 0, blocked: 1, pending: 2 };

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
 * Which of several open tasks is the one to act on: the work in flight, then the work that
 * stalled, then the queue behind it.
 *
 * The tiebreak inside a rank differs by what the rank means, and that split is the reason the
 * queue has a rank of its own. A `pending` subtask is one nobody has touched, so it waits behind
 * its older siblings in `queueOrder`: without that, splitting a job into three subtasks would
 * hand back the last one created and leave the first two queued forever. An `active` or
 * `blocked` task is one somebody was in the middle of, so `updatedAt` decides and a resumed
 * session lands back where it stopped.
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
      /** Only read on insert: where a task sits in the tree does not change afterwards. */
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
    if (parent === undefined || parent.trim() === '') return null;
    const id = parent.trim();
    const row = db.prepare('SELECT id, status FROM task WHERE id = ?').get(id) as
      { id: string; status: string } | undefined;
    if (row === undefined) {
      throw new TaskPatchError('guard', `no task with id "${id}" to split this one out of`);
    }
    if (row.status === 'done') {
      throw new TaskPatchError(
        'guard',
        `task ${id} is done, so it takes no new subtasks; start a root task instead`,
      );
    }
    return id;
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

  async show(id?: string): Promise<StoredTask> {
    if (id !== undefined) return this.readTask(id);
    const activeId = await this.activeId();
    if (activeId === null) throw new TaskNotFoundError('No active task found');
    return this.readTask(activeId);
  }

  /**
   * Applies a patch to Σ. `report`, when given, is filled with what the write cost that Σ
   * itself does not show — see `PatchReport`.
   */
  async patch(patch: StateDict, id?: string, report?: PatchReport): Promise<StoredTask> {
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

    // Path keys ("plan[1].status") are expanded before the guard runs, so domain
    // rules see the same wholesale shape they were written against.
    const expanded = expandPathPatch(state, patch);
    if (!expanded.ok) return reject('path', expanded.message);

    const validation = validatePatch(skill, state, expanded.patch);
    if (!validation.ok) return reject(validation.category, validation.message);

    const merged = mergeState(state, expanded.patch);

    // A decomposition is not finished while its pieces are open, whatever its own Σ says. The
    // skill guard cannot see this — it reads one state, and the subtasks are other rows — and
    // closing a parent early is what leaves work orphaned: every view that picks a task to
    // inject walks the tree, so a finished parent hides the open branch under it.
    if (merged.status === 'done' && state.status !== 'done') {
      const open = this.openChildCount(db, taskId);
      if (open > 0) {
        return reject(
          'guard',
          `task ${taskId} has ${open} open subtask(s); finish or skip them before closing it`,
        );
      }
    }

    // Stamped before validation, so the stamps are checked like everything else the write
    // produces, and before the transaction, so a refused patch spawns no git subprocess.
    const stamps = stampVerifications(state, merged, () => ({
      at: now,
      commit: gitHead(projectDirOf(this.rootDir)),
    }));
    const parsed = skill.schema.safeParse(merged);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue === undefined ? '' : ` at "${issue.path.join('.')}"`;
      const why = issue === undefined ? 'unknown reason' : issue.message;
      return reject('schema', `State validation failed${where}: ${why}`);
    }

    // Written before the transaction so a patch that the schema then refuses leaves no
    // note behind: nothing was superseded by a write that never happened.
    const note = stampHistoryNote(stamps);

    db.transaction(() => {
      this.upsert(db, {
        id: taskId,
        skill: row.skill,
        notation: isNotation(row.notation) ? row.notation : DEFAULT_NOTATION,
        createdAt: row.created_at,
        updatedAt: now,
        state: merged,
      });
      // The patch is recorded as sent: the history shows what the agent asked for,
      // which is what an audit of a rejected or surprising patch needs. The note carries
      // what the write then did to the stamps, which the patch cannot show.
      this.insertHistory(db, taskId, now, patch, true, undefined, note);
      // Σ was just written, so this is the moment its file artifacts are true of the tree;
      // a later read compares the disk against what was recorded here.
      recordArtifactStamps(db, taskId, merged, projectDirOf(this.rootDir), now);
    });

    if (report !== undefined) report.stamps = stamps;
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

  async finish(summary: string, id?: string): Promise<StoredTask> {
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
    });

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
