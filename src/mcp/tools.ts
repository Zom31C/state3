import { isRejectCategory } from '../core/rejections.js';
import type { RejectCategory } from '../core/rejections.js';
import { projectDirOf } from '../core/paths.js';
import type { StateDict } from '../core/types.js';
import { formatRuntimeInfo, runtimeInfo } from '../runtime-info.js';
import { driftWarnings } from '../tasks/artifact-stamps.js';
import type { DriftedArtifact } from '../tasks/artifact-stamps.js';
import { artifactWarnings, missingArtifactPaths } from '../tasks/artifacts.js';
import { isNotation, NOTATIONS } from '../tasks/notation.js';
import type { ProjectEntry, StoreResolver, TaskStorePort } from '../tasks/ports.js';
import { describeProjects } from '../tasks/projects.js';
import { renderStateSize, renderTaskHead } from '../tasks/render.js';
import type {
  HistoryEntry,
  PatchReport,
  StartOptions,
  StoredTask,
  TaskSummary,
} from '../tasks/store.js';
import { stampWarnings } from '../tasks/verifications.js';

export type { ProjectEntry, StoreResolver, TaskStorePort } from '../tasks/ports.js';

export interface ToolResult {
  ok: boolean;
  content: string;
  isError?: boolean;
}

export interface TaskToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

export interface ClassifiedError {
  kind: 'not-found' | 'patch';
  category?: string;
  message: string;
}

/**
 * Classifies store failures by shape (`err.name`, `err.category`) instead of
 * `instanceof`, so this module never needs the error classes as values.
 */
export function classifyError(err: unknown): ClassifiedError {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof Error && err.name === 'TaskNotFoundError') {
    return { kind: 'not-found', message };
  }
  if (typeof err === 'object' && err !== null && 'category' in err) {
    const category = (err as { category: unknown }).category;
    if (typeof category === 'string' && category.length > 0) {
      return { kind: 'patch', category, message };
    }
  }
  return { kind: 'patch', message };
}

const REMINDER =
  'Keep this state current: after every meaningful step call task_patch with only the fields that changed. ' +
  'Call task_show to reload the state and the procedure whenever the session was compacted or restarted.';

/** What `task_show` answers with: Σ and the procedure, or the cost of each field of Σ. */
export const TASK_SHOW_VIEWS = ['state', 'size'] as const;

const NO_TASK_HINT = 'Start one with task_start, or list existing tasks with task_list.';

function rootNote(store: TaskStorePort): string {
  return store.rootDir === undefined ? '' : ` (state root: ${store.rootDir})`;
}

/** Exported for the knowledge-base tools: one shape of answer, whichever half of the project answered. */
export function success(content: string): ToolResult {
  return { ok: true, content };
}

export function failure(content: string): ToolResult {
  return { ok: false, isError: true, content };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function notFoundMessage(info: ClassifiedError, note = ''): string {
  return `No task found: ${info.message}\n${NO_TASK_HINT}${note}`;
}

function failureFromError(err: unknown, note = ''): ToolResult {
  const info = classifyError(err);
  if (info.kind === 'not-found') return failure(notFoundMessage(info, note));
  return failure(info.message.length > 0 ? info.message : 'unknown error');
}

type ArgCheck<T> = { ok: true; value: T } | { ok: false; message: string };

export function requireString(args: Record<string, unknown>, name: string): ArgCheck<string> {
  const raw = args[name];
  if (raw === undefined) return { ok: false, message: `missing required argument: ${name}` };
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, message: `argument ${name} must be a non-empty string` };
  }
  return { ok: true, value: raw };
}

export function optionalString(
  args: Record<string, unknown>,
  name: string,
): ArgCheck<string | undefined> {
  const raw = args[name];
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, message: `argument ${name} must be a non-empty string when provided` };
  }
  return { ok: true, value: raw };
}

function optionalStringArray(
  args: Record<string, unknown>,
  name: string,
): ArgCheck<string[] | undefined> {
  const raw = args[name];
  if (raw === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(raw)) {
    return { ok: false, message: `argument ${name} must be an array of strings when provided` };
  }
  if (raw.some((item) => typeof item !== 'string' || item.trim() === '')) {
    return { ok: false, message: `argument ${name} must contain only non-empty strings` };
  }
  return { ok: true, value: raw as string[] };
}

function requireStateDict(args: Record<string, unknown>, name: string): ArgCheck<StateDict> {
  const raw = args[name];
  if (raw === undefined) return { ok: false, message: `missing required argument: ${name}` };
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: `argument ${name} must be a JSON object of state fields (not an array, not null)`,
    };
  }
  return { ok: true, value: raw as StateDict };
}

export function optionalPositiveInt(
  args: Record<string, unknown>,
  name: string,
): ArgCheck<number | undefined> {
  const raw = args[name];
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    return { ok: false, message: `argument ${name} must be an integer >= 1` };
  }
  return { ok: true, value: raw };
}

/** Picks the store this call applies to, or turns a bad `project` into a result. */
function resolveStore(
  resolver: StoreResolver,
  args: Record<string, unknown>,
): { ok: true; store: TaskStorePort } | { ok: false; result: ToolResult } {
  const project = optionalString(args, 'project');
  if (!project.ok) return { ok: false, result: failure(project.message) };
  try {
    return { ok: true, store: resolver.resolve(project.value) };
  } catch (err) {
    return { ok: false, result: failureFromError(err) };
  }
}

/**
 * One hint per rejection category. Exhaustive by construction: the shared
 * vocabulary types the table, so a category added in `core/rejections.ts` fails
 * to compile here until it has a hint, and P names it from the same array.
 */
const PATCH_HINTS: Record<RejectCategory, string> = {
  'unknown-key':
    'remove keys not present in the schema — task_show lists the fields that can be patched.',
  guard:
    'a domain rule rejected this transition; follow the guard message above (for example, a done plan item cannot go back to pending).',
  path: 'check the path key: it must name an array field of the current state, use a zero-based index inside the existing range (or [+] to append), and address one field at a time.',
  skill:
    'name a skill this runtime has, or omit the argument to use the default; task_list prints the available skills.',
  notation:
    'notation must be one of the listed values ("plain" prose or "compact" pseudocode), or omitted for plain.',
  'type-coercion':
    'check value types against the schema: strings for text, numbers for counts, booleans for flags, arrays where the schema expects them.',
  schema:
    'the merged state would not satisfy the schema; send a smaller patch that only sets the fields you mean to change.',
};

const FALLBACK_HINT =
  're-read the current state with task_show and send a smaller, well-typed patch.';

function patchHint(category: string): string {
  return isRejectCategory(category) ? PATCH_HINTS[category] : FALLBACK_HINT;
}

function patchFailureMessage(info: ClassifiedError, note = ''): string {
  if (info.kind === 'not-found') return notFoundMessage(info, note);
  if (info.category === undefined) {
    return `Patch failed: ${info.message}\nThe task state was not modified.`;
  }
  return [
    `Patch rejected (${info.category}): ${info.message}`,
    'The task state was not modified — the invalid patch was discarded.',
    `Hint: ${patchHint(info.category)}`,
  ].join('\n');
}

/** Σ alone: the cheap response for a write. P comes from task_show. */
export function renderState(task: StoredTask): string {
  return renderTaskHead(task);
}

/** Σ plus the procedure P of the task's own skill and notation. */
export function renderStateWithProcedure(store: TaskStorePort, task: StoredTask): string {
  const head = renderTaskHead(task);
  const instructions = store.instructionsFor(task);
  if (instructions.trim() === '') return head;
  return `${head}\n\n## How to keep this state (P)\n${instructions}`;
}

function renderSummary(summary: TaskSummary): string {
  return (
    `- ${summary.id} [${summary.skill}] (${summary.status}) ` +
    `progress ${summary.progressDone}/${summary.progressTotal}` +
    ` updated ${summary.updatedAt} — ${summary.goal}`
  );
}

/**
 * What a caller may address besides the primary root, which skills exist, and
 * which build is answering — the last one because a host keeps the server it
 * started, so a rebuild is invisible until the host restarts.
 */
async function renderCapabilities(resolver: StoreResolver, store: TaskStorePort): Promise<string> {
  const lines: string[] = [];
  const skills = store.skillNames?.();
  if (skills !== undefined && skills.length > 0) lines.push(`skills: ${skills.join(', ')}`);
  const projects: readonly ProjectEntry[] = resolver.projects();
  if (projects.length > 0) lines.push(`projects: ${describeProjects(projects)}`);
  lines.push(formatRuntimeInfo(await runtimeInfo()));
  return `\n${lines.join('\n')}`;
}

/**
 * The artifacts the disk disagrees with Σ about, as lines under a read; empty when the tree
 * still matches, and when the store cannot answer at all.
 */
function driftLines(drifted: readonly DriftedArtifact[] | undefined): string[] {
  return drifted === undefined ? [] : driftWarnings(drifted);
}

function renderHistoryEntry(entry: HistoryEntry, index: number): string {
  const keys = Object.keys(entry.patch);
  const change = keys.length === 0 ? 'empty patch' : keys.join(', ');
  if (entry.ok) {
    const note = entry.note === undefined ? '' : ` — ${entry.note}`;
    return `${index + 1}. ${entry.at} ok — patched: ${change}${note}`;
  }
  const category = entry.error?.category ?? 'invalid';
  const message = entry.error?.message ?? 'patch rejected';
  return `${index + 1}. ${entry.at} REJECTED (${category}) — patched: ${change} — ${message}`;
}

async function startTask(
  resolver: StoreResolver,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const resolved = resolveStore(resolver, args);
  if (!resolved.ok) return resolved.result;
  const store = resolved.store;

  const goal = requireString(args, 'goal');
  if (!goal.ok) return failure(goal.message);
  const plan = optionalStringArray(args, 'plan');
  if (!plan.ok) return failure(plan.message);
  const skill = optionalString(args, 'skill');
  if (!skill.ok) return failure(skill.message);
  const notation = optionalString(args, 'notation');
  if (!notation.ok) return failure(notation.message);
  if (notation.value !== undefined && !isNotation(notation.value)) {
    return failure(`argument notation must be one of: ${NOTATIONS.join(', ')}`);
  }

  const options: StartOptions = {};
  if (plan.value !== undefined) options.plan = plan.value;
  if (skill.value !== undefined) options.skill = skill.value;
  if (notation.value !== undefined && isNotation(notation.value)) options.notation = notation.value;

  try {
    const task = await store.start(goal.value, options);
    return success(
      `Started task ${task.meta.id} [${task.meta.skill}] at ${task.meta.path}.\n\n` +
        `${renderState(task)}\n\n${REMINDER}`,
    );
  } catch (err) {
    return failure(patchFailureMessage(classifyError(err), rootNote(store)));
  }
}

async function showTask(
  resolver: StoreResolver,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const resolved = resolveStore(resolver, args);
  if (!resolved.ok) return resolved.result;
  const store = resolved.store;

  const id = optionalString(args, 'id');
  if (!id.ok) return failure(id.message);
  const view = optionalString(args, 'view');
  if (!view.ok) return failure(view.message);
  if (view.value !== undefined && !(TASK_SHOW_VIEWS as readonly string[]).includes(view.value)) {
    return failure(`argument view must be one of: ${TASK_SHOW_VIEWS.join(', ')}`);
  }
  try {
    const task = await store.show(id.value);
    // The size report answers "what should I compress", so it carries no Σ and no procedure:
    // both are what it is measuring, and repeating them would cost what the call saves.
    if (view.value === 'size') return success(renderStateSize(task.state));
    const parts = [renderStateWithProcedure(store, task)];
    // A read is the moment to compare Σ against the tree: this is the call a resumed session
    // makes before acting on what Σ says, and the tree may have been changed by hand while
    // the session was gone.
    parts.push(...driftLines(await store.driftedArtifacts?.(task.meta.id)));
    // The build is named here and not on every answer because this is the call a resumed
    // session makes: a host keeps the server it started, so a feature that exists in the
    // repository may not exist in the code that is answering, and this line is the only
    // place the difference is visible without leaving the session.
    parts.push(formatRuntimeInfo(await runtimeInfo()));
    return success(parts.join('\n\n'));
  } catch (err) {
    return failureFromError(err, rootNote(store));
  }
}

/**
 * The artifact paths a patch just wrote that are not on disk, as a note under the answer.
 *
 * Checked only when the patch touched `artifacts`: a warning repeated on every patch of a
 * task that carries one stale path trains the agent to skip the tail of the answer, and the
 * tail is where the refusals live.
 */
function artifactNote(store: TaskStorePort, state: StateDict, patch: StateDict): string {
  if (!('artifacts' in patch)) return '';
  const rootDir = store.rootDir;
  if (rootDir === undefined) return '';
  const lines = artifactWarnings(missingArtifactPaths(state, projectDirOf(rootDir)));
  return lines.length === 0 ? '' : `\n${lines.join('\n')}`;
}

/**
 * The verification stamps this patch detached, as a note under the answer.
 *
 * Σ cannot show it: after the write, every entry carries a stamp and nothing marks the one
 * that was replaced. The agent sent the patch that replaced it, so the agent is the one who
 * has to be told — silently losing "which tree this check ran on" is what makes a supervisor's
 * audit impossible after the fact.
 */
function stampNote(report: PatchReport): string {
  if (report.stamps === undefined) return '';
  const lines = stampWarnings(report.stamps);
  return lines.length === 0 ? '' : `\n${lines.join('\n')}`;
}

async function patchTask(
  resolver: StoreResolver,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const resolved = resolveStore(resolver, args);
  if (!resolved.ok) return resolved.result;
  const store = resolved.store;

  const patch = requireStateDict(args, 'patch');
  if (!patch.ok) return failure(patch.message);
  const id = optionalString(args, 'id');
  if (!id.ok) return failure(id.message);
  try {
    const report: PatchReport = {};
    const task = await store.patch(patch.value, id.value, report);
    return success(
      `Patched task ${task.meta.id}.\n\n${renderState(task)}` +
        stampNote(report) +
        artifactNote(store, task.state, patch.value),
    );
  } catch (err) {
    return failure(patchFailureMessage(classifyError(err), rootNote(store)));
  }
}

async function finishTask(
  resolver: StoreResolver,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const resolved = resolveStore(resolver, args);
  if (!resolved.ok) return resolved.result;
  const store = resolved.store;

  const summary = requireString(args, 'summary');
  if (!summary.ok) return failure(summary.message);
  const id = optionalString(args, 'id');
  if (!id.ok) return failure(id.message);
  try {
    const task = await store.finish(summary.value, id.value);
    return success(`Finished task ${task.meta.id}.\n\n${renderState(task)}`);
  } catch (err) {
    return failureFromError(err, rootNote(store));
  }
}

async function listTasks(
  resolver: StoreResolver,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const resolved = resolveStore(resolver, args);
  if (!resolved.ok) return resolved.result;
  const store = resolved.store;

  try {
    const summaries = await store.list();
    const capabilities = await renderCapabilities(resolver, store);
    if (summaries.length === 0) return success(`no tasks${rootNote(store)}${capabilities}`);
    return success(
      `Tasks (${summaries.length}):\n${summaries.map(renderSummary).join('\n')}${capabilities}`,
    );
  } catch (err) {
    return failureFromError(err, rootNote(store));
  }
}

async function taskHistory(
  resolver: StoreResolver,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const resolved = resolveStore(resolver, args);
  if (!resolved.ok) return resolved.result;
  const store = resolved.store;

  const id = optionalString(args, 'id');
  if (!id.ok) return failure(id.message);
  const limit = optionalPositiveInt(args, 'limit');
  if (!limit.ok) return failure(limit.message);
  try {
    const entries = await store.history(id.value, limit.value);
    if (entries.length === 0) return success('no history entries');
    const head =
      id.value === undefined ? 'History (active task):' : `History for task ${id.value}:`;
    return success(`${head}\n${entries.map(renderHistoryEntry).join('\n')}`);
  } catch (err) {
    return failureFromError(err, rootNote(store));
  }
}

/** Tool handlers must never throw: hosts surface a thrown error as a broken call. */
export function guarded(
  args: Record<string, unknown>,
  body: (args: Record<string, unknown>) => Promise<ToolResult>,
): Promise<ToolResult> {
  const safeArgs = isPlainObject(args) ? args : {};
  return body(safeArgs).catch(failureFromError);
}

export const PROJECT_ARG = {
  type: 'string',
  description:
    'Name of a declared project whose state root the call applies to. Omit it for this project. task_list prints the declared names.',
};

const START_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    goal: { type: 'string', description: 'One-sentence outcome the task must reach.' },
    plan: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Optional ordered steps, one string per step. Only for skills whose state has a plan array.',
    },
    skill: {
      type: 'string',
      description:
        'Kind of task, which decides the state fields, the domain rules and the procedure: "dev-task" implements work in this project, "supervise-task" reviews work another agent does. Omit for the default. task_list prints what this runtime has.',
    },
    notation: {
      type: 'string',
      enum: [...NOTATIONS],
      description:
        'How state values must be written: "plain" prose, or "compact" pseudocode that costs fewer tokens on every turn. Omit for plain.',
    },
    project: PROJECT_ARG,
  },
  required: ['goal'],
  additionalProperties: false,
};

const SHOW_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Task id. Defaults to the active task.' },
    view: {
      type: 'string',
      enum: [...TASK_SHOW_VIEWS],
      description:
        'state (default): Σ with the procedure for keeping it. size: no Σ — how many characters each field of Σ costs, largest first, which is what to shorten when the state has grown.',
    },
    project: PROJECT_ARG,
  },
  required: [],
  additionalProperties: false,
};

const PATCH_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    patch: {
      type: 'object',
      description:
        'State fields to merge into the current state (only the changed ones). A null value deletes a key. A key like "plan[1].status" changes one array item without resending the array, and "plan[+]" appends one.',
      additionalProperties: true,
    },
    id: { type: 'string', description: 'Task id. Defaults to the active task.' },
    project: PROJECT_ARG,
  },
  required: ['patch'],
  additionalProperties: false,
};

const FINISH_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Short summary of the outcome.' },
    id: { type: 'string', description: 'Task id. Defaults to the active task.' },
    project: PROJECT_ARG,
  },
  required: ['summary'],
  additionalProperties: false,
};

const LIST_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    project: PROJECT_ARG,
  },
  required: [],
  additionalProperties: false,
};

const HISTORY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Task id. Defaults to the active task.' },
    limit: { type: 'integer', minimum: 1, description: 'Return at most this many entries.' },
    project: PROJECT_ARG,
  },
  required: [],
  additionalProperties: false,
};

export function createTaskTools(resolver: StoreResolver): TaskToolDefinition[] {
  return [
    {
      name: 'task_start',
      description:
        'Start a new task whose state lives outside the conversation, so it survives session compaction. Call it once when a multi-step job begins, with a one-sentence goal, the skill that fits the job, and an optional ordered plan. Returns the new task id and its initial state.',
      inputSchema: START_SCHEMA,
      handler: (args) => guarded(args, (a) => startTask(resolver, a)),
    },
    {
      name: 'task_show',
      description:
        'Read the compact current state of the active task (or a task by id), together with the procedure for keeping that state. Call it first after the session was compacted or restarted, and any time you are unsure what has already been done.',
      inputSchema: SHOW_SCHEMA,
      handler: (args) => guarded(args, (a) => showTask(resolver, a)),
    },
    {
      name: 'task_patch',
      description:
        'Update the task state after a meaningful step: progress, artifacts, checks, decisions, blockers, next action. Patches are validated deterministically against the schema and the domain guard; a rejected patch leaves the state untouched and returns a diagnostic telling you how to fix it.',
      inputSchema: PATCH_SCHEMA,
      handler: (args) => guarded(args, (a) => patchTask(resolver, a)),
    },
    {
      name: 'task_finish',
      description:
        'Mark the task done and archive it with a short summary of the outcome. Call it when the goal is reached or the task is abandoned, after the final checks have been recorded.',
      inputSchema: FINISH_SCHEMA,
      handler: (args) => guarded(args, (a) => finishTask(resolver, a)),
    },
    {
      name: 'task_list',
      description:
        'List every tracked task with its skill, status and progress, plus the skills and projects this runtime knows. Call it to recover a task id when nothing is active, or to see what a new task can be.',
      inputSchema: LIST_SCHEMA,
      handler: (args) => guarded(args, (a) => listTasks(resolver, a)),
    },
    {
      name: 'task_history',
      description:
        'Show the most recent patches of a task, including the rejected ones. Call it to audit what changed and to see why a patch was rejected.',
      inputSchema: HISTORY_SCHEMA,
      handler: (args) => guarded(args, (a) => taskHistory(resolver, a)),
    },
  ];
}
