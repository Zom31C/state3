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
import { DEFAULT_NOTATION, isNotation, notationInstructions, NOTATIONS } from './notation.js';
import type { Notation } from './notation.js';
import { composeProcedure } from './procedure.js';
import { builtinSkillRegistry } from './registry.js';
import type { SkillRegistry } from './registry.js';
import { stampVerifications } from './verifications.js';

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
}

export interface TaskSummary {
  id: string;
  goal: string;
  status: string;
  skill: string;
  updatedAt: string;
  progressDone: number;
  progressTotal: number;
}

/** What `start` may be asked for beyond the goal. */
export interface StartOptions {
  /** Skill name; defaults to the registry default. */
  skill?: string;
  /** How Σ values must be written; defaults to plain prose. */
  notation?: Notation;
  /** Ordered steps, only for skills whose Σ has a plan array. */
  plan?: readonly string[];
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
}

interface HistoryRow {
  at: string;
  ok: number;
  category: string | null;
  message: string | null;
  patch: string;
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

  constructor(rootDir: string, skills: SkillRegistry = builtinSkillRegistry()) {
    this.rootDir = rootDir;
    this.skills = skills;
  }

  /** Absolute path of the database file this store reads and writes. */
  get dbPath(): string {
    return join(this.rootDir, STATE_DB_FILENAME);
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
    if (this.handle === undefined) this.handle = openStateDatabase(this.dbPath);
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
  ): void {
    db.prepare(
      `INSERT INTO task_history (task_id, at, ok, category, message, patch)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      taskId,
      at,
      ok ? 1 : 0,
      error?.category ?? null,
      error?.message ?? null,
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
    },
  ): void {
    const skill = this.skillFor(row.skill, row.id);
    const progress = skill.progress?.(row.state) ?? { done: 0, total: 0 };
    const status = typeof row.state.status === 'string' ? row.state.status : 'unknown';
    const goal = typeof row.state.goal === 'string' ? row.state.goal : '';

    db.prepare(
      `INSERT INTO task (id, skill, notation, status, goal, state, progress_done, progress_total, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

    const state: StateDict = { ...structuredClone(skill.initialState), goal };
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

    const db = this.database();
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
          });
        });
        return this.readTask(id);
      } catch (err) {
        if (!isUniqueConstraintError(err)) throw err;
      }
    }
  }

  async show(id?: string): Promise<StoredTask> {
    if (id !== undefined) return this.readTask(id);
    const activeId = await this.activeId();
    if (activeId === null) throw new TaskNotFoundError('No active task found');
    return this.readTask(activeId);
  }

  async patch(patch: StateDict, id?: string): Promise<StoredTask> {
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
    // Stamped before validation, so the stamps are checked like everything else the write
    // produces, and before the transaction, so a refused patch spawns no git subprocess.
    stampVerifications(state, merged, () => ({
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
      // which is what an audit of a rejected or surprising patch needs.
      this.insertHistory(db, taskId, now, patch, true);
    });

    return this.readTask(taskId);
  }

  async finish(summary: string, id?: string): Promise<StoredTask> {
    const taskId = id ?? (await this.activeId());
    if (taskId === null) throw new TaskNotFoundError('No active task found');

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
            `layout and has no database: run \`skillstate task migrate --root ${this.rootDir}\``,
        );
      }
      return [];
    }

    const rows = db
      .prepare('SELECT * FROM task ORDER BY updated_at DESC, id DESC')
      .all() as TaskRow[];

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
        summaries.push({
          id: row.id,
          goal: row.goal,
          status: row.status,
          skill: skill.name,
          updatedAt: row.updated_at,
          progressDone: progress.done,
          progressTotal: progress.total,
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
      }
      entries.push(entry);
    }
    return entries;
  }

  /**
   * The task the tools act on when no id is given: the most recently updated open
   * one. `active` wins, but a `blocked` task still counts as open — an agent that
   * has just reported a blocker must be able to patch its way out of it without
   * first looking the id up with task_list.
   */
  async activeId(): Promise<string | null> {
    const all = await this.list();
    const open = all.find((s) => s.status === 'active') ?? all.find((s) => s.status !== 'done');
    return open?.id ?? null;
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
