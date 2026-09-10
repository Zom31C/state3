import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RejectCategory } from '../core/rejections.js';
import type { Skill } from '../core/skill.js';
import { expandPathPatch, isPlainObject, mergeState } from '../core/state.js';
import type { StateDict, StateValue } from '../core/types.js';
import { validatePatch } from '../core/validator.js';
import { DEFAULT_NOTATION, isNotation, notationInstructions, NOTATIONS } from './notation.js';
import type { Notation } from './notation.js';
import { composeProcedure } from './procedure.js';
import { builtinSkillRegistry } from './registry.js';
import type { SkillRegistry } from './registry.js';

/** A finished task has no next step; its outcome lives in `decisions`. */
const FINISHED_NEXT_ACTION = 'None — task finished; the outcome is the last decisions entry.';

export interface TaskMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
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

/**
 * Shape of the JSON record on disk. `skill` and `notation` are optional because
 * records written before they existed carry neither; such a record is read as the
 * default skill in plain notation and is normalized on the next write.
 */
interface TaskRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  skill?: string;
  notation?: string;
  state: StateDict;
}

export class TaskStore {
  /** Absolute state directory; the tool layer reports it in diagnostics. */
  readonly rootDir: string;

  private readonly skills: SkillRegistry;

  constructor(rootDir: string, skills: SkillRegistry = builtinSkillRegistry()) {
    this.rootDir = rootDir;
    this.skills = skills;
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

  private taskPath(id: string): string {
    return join(this.rootDir, `${id}.json`);
  }

  private historyPath(id: string): string {
    return join(this.rootDir, `${id}.history.jsonl`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
  }

  private generateId(): string {
    const raw = Math.random().toString(36).slice(2);
    const suffix = (raw + '0000').slice(0, 4);
    return `task-${Date.now().toString(36)}-${suffix}`;
  }

  /** Atomic write: tmp file in the same directory, then rename (atomic on POSIX and NTFS). */
  private async writeAtomic(id: string, content: string): Promise<void> {
    await this.ensureDir();
    const target = this.taskPath(id);
    // Unique per write: the MCP server and the CLI may patch the same task concurrently.
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, content, 'utf-8');
    await rename(tmp, target);
  }

  private async appendHistory(id: string, entry: HistoryEntry): Promise<void> {
    await this.ensureDir();
    await appendFile(this.historyPath(id), JSON.stringify(entry) + '\n', 'utf-8');
  }

  private skillNameOf(record: TaskRecord): string {
    return typeof record.skill === 'string' && record.skill !== ''
      ? record.skill
      : this.skills.defaultName;
  }

  private notationOf(record: TaskRecord): Notation {
    return isNotation(record.notation) ? record.notation : DEFAULT_NOTATION;
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

  private metaOf(record: TaskRecord, updatedAt: string = record.updatedAt): TaskMeta {
    return {
      id: record.id,
      createdAt: record.createdAt,
      updatedAt,
      path: this.taskPath(record.id),
      skill: this.skillNameOf(record),
      notation: this.notationOf(record),
    };
  }

  private async readRaw(id: string): Promise<TaskRecord> {
    let content: string;
    try {
      content = await readFile(this.taskPath(id), 'utf-8');
    } catch {
      throw new TaskNotFoundError(`No task found with id "${id}"`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      throw new Error(
        `Task ${id} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Task ${id} is not a task record; the file was changed by hand.`);
    }
    const record = parsed as TaskRecord;
    if (!isPlainObject(record.state)) {
      throw new Error(`Task ${id} has no state object; the file was changed by hand.`);
    }
    return record;
  }

  private async readTask(id: string): Promise<StoredTask> {
    const raw = await this.readRaw(id);
    const skill = this.skillFor(this.skillNameOf(raw), id);
    const parsed = skill.schema.safeParse(raw.state);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue === undefined ? '' : ` at "${issue.path.join('.')}"`;
      const why = issue === undefined ? 'invalid state' : issue.message;
      throw new Error(
        `Task ${id} does not satisfy the "${skill.name}" schema${where}: ${why}. ` +
          'It was written by hand or by a runtime with a different schema.',
      );
    }
    return { meta: this.metaOf(raw), state: raw.state };
  }

  async start(goal: string, options: StartOptions = {}): Promise<StoredTask> {
    await this.ensureDir();
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

    const id = this.generateId();
    const now = new Date().toISOString();
    const record: TaskRecord = {
      id,
      createdAt: now,
      updatedAt: now,
      skill: skill.name,
      notation,
      state,
    };
    await this.writeAtomic(id, JSON.stringify(record, null, 2) + '\n');

    return { meta: this.metaOf(record), state };
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

    const raw = await this.readRaw(taskId);
    const skill = this.skillFor(this.skillNameOf(raw), taskId);

    /** A rejected patch stays in the history: the audit trail includes what did not apply. */
    const recordRejection = async (category: RejectCategory, message: string): Promise<void> => {
      await this.appendHistory(taskId, {
        at: new Date().toISOString(),
        patch,
        ok: false,
        error: { category, message },
      });
    };

    // Path keys ("plan[1].status") are expanded before the guard runs, so domain
    // rules see the same wholesale shape they were written against.
    const expanded = expandPathPatch(raw.state, patch);
    if (!expanded.ok) {
      await recordRejection('path', expanded.message);
      throw new TaskPatchError('path', expanded.message);
    }

    const validation = validatePatch(skill, raw.state, expanded.patch);
    if (!validation.ok) {
      await recordRejection(validation.category, validation.message);
      throw new TaskPatchError(validation.category, validation.message);
    }

    const merged = mergeState(raw.state, expanded.patch);
    const parsed = skill.schema.safeParse(merged);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue === undefined ? '' : ` at "${issue.path.join('.')}"`;
      const why = issue === undefined ? 'unknown reason' : issue.message;
      const message = `State validation failed${where}: ${why}`;
      await recordRejection('schema', message);
      throw new TaskPatchError('schema', message);
    }

    const now = new Date().toISOString();
    const record: TaskRecord = {
      id: taskId,
      createdAt: raw.createdAt,
      updatedAt: now,
      skill: skill.name,
      notation: this.notationOf(raw),
      state: merged,
    };
    await this.writeAtomic(taskId, JSON.stringify(record, null, 2) + '\n');
    // The patch is recorded as sent: the history shows what the agent asked for,
    // which is what an audit of a rejected or surprising patch needs.
    await this.appendHistory(taskId, { at: now, patch, ok: true });

    return { meta: this.metaOf(record, now), state: merged };
  }

  async finish(summary: string, id?: string): Promise<StoredTask> {
    const taskId = id ?? (await this.activeId());
    if (taskId === null) throw new TaskNotFoundError('No active task found');

    const task = await this.readTask(taskId);
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

    const record: TaskRecord = {
      id: taskId,
      createdAt: task.meta.createdAt,
      updatedAt: now,
      skill: skill.name,
      notation: task.meta.notation,
      state,
    };
    await this.writeAtomic(taskId, JSON.stringify(record, null, 2) + '\n');

    // Fresh literals (not an interface-typed variable) so TypeScript sees a type
    // assignable to the StateDict index signature.
    await this.appendHistory(taskId, {
      at: now,
      patch: {
        status: 'done',
        decisions,
        next: { action: FINISHED_NEXT_ACTION, risk: 'safe' },
      },
      ok: true,
    });

    return { meta: this.metaOf(record, now), state };
  }

  async list(): Promise<TaskSummary[]> {
    let files: string[];
    try {
      files = await readdir(this.rootDir);
    } catch {
      return [];
    }

    const summaries: TaskSummary[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const record = JSON.parse(await readFile(join(this.rootDir, file), 'utf-8')) as TaskRecord;
        const skill = this.skillFor(this.skillNameOf(record), record.id);
        if (!skill.schema.safeParse(record.state).success) continue;
        const progress = skill.progress?.(record.state) ?? { done: 0, total: 0 };
        summaries.push({
          id: record.id,
          goal: typeof record.state.goal === 'string' ? record.state.goal : '',
          status: typeof record.state.status === 'string' ? record.state.status : 'unknown',
          skill: skill.name,
          updatedAt: record.updatedAt,
          progressDone: progress.done,
          progressTotal: progress.total,
        });
      } catch {
        // A torn, hand-edited or foreign-schema record must not break the list.
        continue;
      }
    }

    summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return summaries;
  }

  async history(id?: string, limit?: number): Promise<HistoryEntry[]> {
    const taskId = id ?? (await this.activeId());
    if (taskId === null) throw new TaskNotFoundError('No active task found');

    let content: string;
    try {
      content = await readFile(this.historyPath(taskId), 'utf-8');
    } catch {
      return [];
    }

    const entries: HistoryEntry[] = [];
    for (const line of content.split('\n')) {
      if (line.trim() === '') continue;
      try {
        entries.push(JSON.parse(line) as HistoryEntry);
      } catch {
        continue;
      }
    }

    const effectiveLimit = limit ?? 20;
    return entries.slice(-effectiveLimit);
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
}
