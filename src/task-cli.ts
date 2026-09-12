import { resolve } from 'node:path';
import type { StateDict } from './core/types.js';
import { formatRuntimeInfo, runtimeInfo } from './runtime-info.js';
import { formatDoctorReport, inspectStateRoot } from './tasks/doctor.js';
import { formatMigrationReport, migrateRootToDatabase } from './tasks/migrate.js';
import { isNotation, NOTATIONS } from './tasks/notation.js';
import { describeProjects, parseProjectsSpec } from './tasks/projects.js';
import { renderTaskHead } from './tasks/render.js';
import type { HistoryEntry, StartOptions, TaskSummary } from './tasks/store.js';
import { TaskStore } from './tasks/store.js';

export type TaskStorePort = Pick<
  TaskStore,
  'start' | 'show' | 'patch' | 'finish' | 'list' | 'history' | 'activeId'
> & {
  /** Optional so test fakes stay small; the CLI closes it to release the database file. */
  close?(): void;
};

export const TASK_SUBCOMMANDS = [
  'start',
  'show',
  'patch',
  'finish',
  'list',
  'history',
  'migrate',
  'doctor',
] as const;
export type TaskSubcommand = (typeof TASK_SUBCOMMANDS)[number];

export const DEFAULT_TASK_ROOT = '.skillstate';

export interface TaskCliOptions {
  root: string;
  subcommand: TaskSubcommand;
  goal: string | null;
  plan: string[];
  id: string | null;
  patch: StateDict | null;
  summary: string | null;
  limit: number | null;
  skill: string | null;
  notation: string | null;
  /** Declared project whose root replaces `--root`; see SKILLSTATE_PROJECTS. */
  project: string | null;
  /** With `migrate`: delete the legacy JSON files instead of archiving them. */
  purge: boolean;
  fromStdin: boolean;
  /** Print the help text and touch no state. */
  help: boolean;
}

export interface TaskCliDeps {
  createStore(root: string): TaskStorePort;
  readStdin(): Promise<string>;
  log(message: string): void;
}

/**
 * The state root this invocation writes to. `--project` resolves a name declared
 * in SKILLSTATE_PROJECTS, which is how one shell reaches the state of another
 * project (a supervisor following a worker) without typing absolute paths.
 */
export function resolveTaskRoot(options: TaskCliOptions, env: NodeJS.ProcessEnv): string {
  if (options.project === null) return resolve(options.root);
  const spec = env.SKILLSTATE_PROJECTS;
  if (spec === undefined || spec.trim() === '') {
    throw new Error('--project needs SKILLSTATE_PROJECTS to declare project roots');
  }
  const entries = parseProjectsSpec(spec);
  const found = entries.find((entry) => entry.name === options.project);
  if (found === undefined) {
    throw new Error(
      `unknown project "${options.project}" — declared: ${describeProjects(entries)}`,
    );
  }
  return found.rootDir;
}

function intArg(raw: string, flag: string, min: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${flag} expects an integer >= ${min}, got "${raw}"`);
  }
  return value;
}

function parsePatchJson(raw: string): StateDict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `patch must be valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('patch must be a JSON object');
  }
  return parsed as StateDict;
}

export function parseTaskArgs(argv: readonly string[]): TaskCliOptions {
  let subcommand: TaskSubcommand | null = null;
  let root = DEFAULT_TASK_ROOT;
  let rootExplicit = false;
  let id: string | null = null;
  let limit: number | null = null;
  let skill: string | null = null;
  let notation: string | null = null;
  let project: string | null = null;
  let help = false;
  let purge = false;
  const plan: string[] = [];
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;
    const takeValue = (name: string): string => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`Missing value for ${name}`);
      i += 1;
      return next;
    };
    switch (token) {
      case '--root':
        root = takeValue(token);
        rootExplicit = true;
        break;
      case '--id':
        id = takeValue(token);
        break;
      case '--limit':
        limit = intArg(takeValue(token), token, 1);
        break;
      case '--plan':
        plan.push(takeValue(token));
        break;
      case '--skill':
        skill = takeValue(token);
        break;
      case '--notation':
        notation = takeValue(token);
        break;
      case '--project':
        project = takeValue(token);
        break;
      case '--purge':
        purge = true;
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        if (token.startsWith('--')) throw new Error(`Unknown argument: ${token}`);
        if (subcommand === null) {
          const found = TASK_SUBCOMMANDS.find((s) => s === token);
          if (found === undefined) {
            throw new Error(
              `Unknown task subcommand: ${token}. Expected one of: ${TASK_SUBCOMMANDS.join(', ')}`,
            );
          }
          subcommand = found;
        } else {
          positional.push(token);
        }
    }
  }

  // Help needs no subcommand and validates nothing: `task --help` must work on its own.
  if (help) {
    return {
      root,
      subcommand: subcommand ?? 'list',
      goal: null,
      plan,
      id,
      patch: null,
      summary: null,
      limit,
      skill,
      notation,
      project,
      purge,
      fromStdin: false,
      help: true,
    };
  }

  if (subcommand === null) {
    throw new Error(`Missing task subcommand. Expected one of: ${TASK_SUBCOMMANDS.join(', ')}`);
  }

  const options: TaskCliOptions = {
    root,
    subcommand,
    goal: null,
    plan,
    id,
    patch: null,
    summary: null,
    limit,
    skill,
    notation,
    project,
    purge,
    fromStdin: false,
    help: false,
  };

  const [first, ...rest] = positional;
  if (rest.length > 0) throw new Error(`Unexpected argument: ${rest[0]}`);

  switch (subcommand) {
    case 'start':
      if (first === undefined) throw new Error('task start requires a goal argument');
      options.goal = first;
      break;
    case 'patch':
      if (first === undefined) {
        throw new Error('task patch requires a JSON patch argument (or "-" to read from stdin)');
      }
      if (first === '-') {
        options.fromStdin = true;
      } else {
        options.patch = parsePatchJson(first);
      }
      break;
    case 'finish':
      if (first === undefined) throw new Error('task finish requires a summary argument');
      options.summary = first;
      break;
    default:
      if (first !== undefined) throw new Error(`Unexpected argument: ${first}`);
      break;
  }

  if (options.limit !== null && subcommand !== 'history') {
    throw new Error('--limit is only valid for task history');
  }
  if (options.plan.length > 0 && subcommand !== 'start') {
    throw new Error('--plan is only valid for task start');
  }
  const TAKES_ID: readonly TaskSubcommand[] = ['show', 'patch', 'finish', 'history'];
  if (options.id !== null && !TAKES_ID.includes(subcommand)) {
    throw new Error(`--id is not valid for task ${subcommand}`);
  }
  if (options.purge && subcommand !== 'migrate') {
    throw new Error('--purge is only valid for task migrate');
  }
  if (options.skill !== null && subcommand !== 'start') {
    throw new Error('--skill is only valid for task start');
  }
  if (options.notation !== null && subcommand !== 'start') {
    throw new Error('--notation is only valid for task start');
  }
  if (options.notation !== null && !isNotation(options.notation)) {
    throw new Error(`--notation expects one of: ${NOTATIONS.join(', ')}`);
  }
  if (options.project !== null && rootExplicit) {
    throw new Error('--project already picks a declared state root, so --root is redundant');
  }

  return options;
}

/** One line per subcommand. The Record is exhaustive by type, so a new subcommand cannot ship undocumented. */
const SUBCOMMAND_HELP: Record<TaskSubcommand, string> = {
  start: 'create a task from a goal; --plan adds steps, --skill and --notation shape Σ',
  show: 'print Σ of the open task, or of --id',
  patch: 'merge a JSON patch into Σ; "-" reads the patch from stdin',
  finish: 'mark the task done and append the summary to decisions',
  list: 'list tasks with skill, status, progress, and the build that is answering',
  history: 'print the audit trail of patches, rejected ones included; --limit N',
  migrate: 'move legacy <id>.json + <id>.history.jsonl into state.db; archives them unless --purge',
  doctor:
    'report on the state root: integrity, schema version, counts, unreadable or dangling rows',
};

/** Flags the help prints; a test feeds each one back to parseTaskArgs. */
const FLAG_HELP: readonly (readonly [flag: string, text: string])[] = [
  ['--root <dir>', 'state root to read and write (default .skillstate)'],
  ['--project <name>', 'a root declared in SKILLSTATE_PROJECTS, instead of --root'],
  ['--id <task>', 'task to act on (default: the most recently updated open task)'],
  ['--plan <step>', 'plan step for start; repeatable'],
  ['--skill <name>', 'skill for start; task list prints the ones this runtime has'],
  ['--notation <name>', 'how to write Σ: plain prose or compact pseudocode'],
  ['--limit <n>', 'history entries to print (default 20)'],
  ['--purge', 'with migrate: delete the legacy files instead of moving them into an archive'],
];

/** The documented flags, as parseTaskArgs spells them. */
export const HELP_FLAGS: readonly string[] = FLAG_HELP.map(([flag]) => flag.split(' ')[0] ?? '');

export function taskHelpText(): string {
  return [
    'skillstate task <subcommand> — keep the progress of long work in an external state Σ',
    '',
    'Subcommands:',
    ...TASK_SUBCOMMANDS.map((name) => `  ${name.padEnd(9)} ${SUBCOMMAND_HELP[name]}`),
    '',
    'Options:',
    ...FLAG_HELP.map(([flag, text]) => `  ${flag.padEnd(18)} ${text}`),
    `  ${'-h, --help'.padEnd(18)} print this help`,
    '',
    'Examples:',
    '  skillstate task start "Ship the adapter" --plan "read the spec" --notation compact',
    '  skillstate task patch - < patch.json',
    '  skillstate task list --root ../other-project/.skillstate',
  ].join('\n');
}

export function formatTaskList(rows: readonly TaskSummary[]): string {
  if (rows.length === 0) return 'no tasks';
  return rows
    .map(
      (r) =>
        `${r.id}  ${r.skill.padEnd(14)}  ${r.status.padEnd(6)}  ` +
        `${r.progressDone}/${r.progressTotal}  ${r.goal}`,
    )
    .join('\n');
}

export function formatHistory(entries: readonly HistoryEntry[]): string {
  if (entries.length === 0) return 'no history';
  return entries
    .map((e) => {
      const verdict = e.ok
        ? 'ok'
        : `rejected (${e.error?.category ?? 'error'}: ${e.error?.message ?? 'unknown reason'})`;
      return `${e.at}  ${verdict}  ${JSON.stringify(e.patch)}`;
    })
    .join('\n');
}

async function readStdinAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export const defaultTaskCliDeps: TaskCliDeps = {
  createStore: (root) => new TaskStore(root),
  readStdin: readStdinAll,
  log: (message) => console.log(message),
};

function describeFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (typeof err === 'object' && err !== null && 'category' in err) {
    const category = (err as { category: unknown }).category;
    if (typeof category === 'string') return `patch rejected (${category}): ${message}`;
  }
  return message;
}

async function executeTaskCommand(options: TaskCliOptions, deps: TaskCliDeps): Promise<void> {
  const root = resolveTaskRoot(options, process.env);

  // migrate and doctor work on the state root itself: migrate writes rows verbatim, and
  // doctor has to be able to report on a database it cannot fully open.
  if (options.subcommand === 'migrate') {
    deps.log(formatMigrationReport(await migrateRootToDatabase(root, { purge: options.purge })));
    return;
  }
  if (options.subcommand === 'doctor') {
    deps.log(formatDoctorReport(await inspectStateRoot(root)));
    return;
  }

  const store = deps.createStore(root);
  try {
    await runStoreCommand(options, store, deps);
  } finally {
    // Release the database file: on Windows an open handle is what stops a project from
    // being moved, archived or deleted, and it is what leaves the -wal sibling behind.
    store.close?.();
  }
}

async function runStoreCommand(
  options: TaskCliOptions,
  store: TaskStorePort,
  deps: TaskCliDeps,
): Promise<void> {
  switch (options.subcommand) {
    case 'start': {
      const goal = options.goal;
      if (goal === null) throw new Error('task start requires a goal argument');
      const startOptions: StartOptions = {};
      if (options.plan.length > 0) startOptions.plan = options.plan;
      if (options.skill !== null) startOptions.skill = options.skill;
      if (options.notation !== null && isNotation(options.notation)) {
        startOptions.notation = options.notation;
      }
      const task = await store.start(goal, startOptions);
      deps.log(renderTaskHead(task));
      deps.log(
        `patch it after each meaningful step: skillstate task patch '{"plan[0].status":"done","next":{"action":"...","risk":"safe"}}'`,
      );
      return;
    }
    case 'show': {
      const task = await (options.id === null ? store.show() : store.show(options.id));
      deps.log(renderTaskHead(task));
      return;
    }
    case 'patch': {
      const raw = options.fromStdin ? await deps.readStdin() : null;
      const patch = raw !== null ? parsePatchJson(raw) : options.patch;
      if (patch === null) {
        throw new Error('task patch requires a JSON patch argument (or "-" to read from stdin)');
      }
      const task = await (options.id === null
        ? store.patch(patch)
        : store.patch(patch, options.id));
      deps.log(renderTaskHead(task));
      return;
    }
    case 'finish': {
      const summary = options.summary;
      if (summary === null) throw new Error('task finish requires a summary argument');
      const task = await (options.id === null
        ? store.finish(summary)
        : store.finish(summary, options.id));
      deps.log(renderTaskHead(task));
      return;
    }
    case 'list':
      deps.log(formatTaskList(await store.list()));
      deps.log(formatRuntimeInfo(await runtimeInfo()));
      return;
    case 'history': {
      const entries =
        options.id === null
          ? options.limit === null
            ? await store.history()
            : await store.history(undefined, options.limit)
          : options.limit === null
            ? await store.history(options.id)
            : await store.history(options.id, options.limit);
      deps.log(formatHistory(entries));
      return;
    }
    case 'migrate':
    case 'doctor':
      // Both act on the state root itself and are handled before the store is opened.
      return;
  }
}

export async function runTaskCommand(
  options: TaskCliOptions,
  deps: TaskCliDeps = defaultTaskCliDeps,
): Promise<void> {
  if (options.help) {
    deps.log(taskHelpText());
    return;
  }
  try {
    await executeTaskCommand(options, deps);
  } catch (err) {
    throw new Error(describeFailure(err));
  }
}
