import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { StateDict } from '../src/core/types.js';
import { droppedDecisions } from '../src/tasks/decisions.js';
import { devTaskSchema } from '../src/tasks/schema.js';
import type { DevTaskState } from '../src/tasks/schema.js';
import type {
  FinishReport,
  Handover,
  HistoryEntry,
  PatchReport,
  StartOptions,
  StoredTask,
  TaskSummary,
} from '../src/tasks/store.js';
import type { TaskCliDeps, TaskStorePort } from '../src/task-cli.js';
import {
  formatHistory,
  formatSubtree,
  formatTaskList,
  HELP_FLAGS,
  parseTaskArgs,
  resolveTaskRoot,
  runTaskCommand,
  taskHelpText,
  TASK_SUBCOMMANDS,
} from '../src/task-cli.js';

class FakeTaskNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskNotFoundError';
  }
}

class FakeTaskPatchError extends Error {
  readonly category: string;

  constructor(category: string, message: string) {
    super(message);
    this.name = 'TaskPatchError';
    this.category = category;
  }
}

function makeState(goal: string, overrides: Partial<DevTaskState> = {}): DevTaskState {
  return {
    goal,
    status: 'active',
    plan: [],
    artifacts: {},
    verifications: [],
    decisions: [],
    blockers: [],
    next: { action: 'Break the goal into plan items', risk: 'safe' },
    ...overrides,
  };
}

/** StoredTask.state is the domain-neutral StateDict; the fake only builds dev-task states. */
const asDict = (state: DevTaskState): StateDict => state as unknown as StateDict;

class FakeStore {
  readonly tasks: StoredTask[] = [];
  readonly entries: HistoryEntry[] = [];
  readonly calls: string[] = [];
  /** The StartOptions object exactly as the CLI forwarded it. */
  readonly startOptions: StartOptions[] = [];
  patchFailure: Error | null = null;
  showFailure: Error | null = null;
  private clock = 0;

  private stamp(): string {
    this.clock += 1;
    return `2026-09-05T00:00:${String(this.clock).padStart(2, '0')}Z`;
  }

  /** Typed view of a task's Σ, read through the schema of its skill. */
  private dev(task: StoredTask): DevTaskState {
    return devTaskSchema.parse(task.state);
  }

  async start(goal: string, options: StartOptions = {}): Promise<StoredTask> {
    const plan = options.plan ?? [];
    this.calls.push(
      `start|${goal}|${options.plan === undefined ? '-' : plan.join(',')}|` +
        `${options.skill ?? '-'}|${options.notation ?? '-'}`,
    );
    this.startOptions.push(options);
    const id = `task-${this.tasks.length + 1}`;
    const at = this.stamp();
    const state = makeState(goal, {
      plan: plan.map((task, index) => ({
        id: String(index + 1),
        task,
        status: 'pending' as const,
        notes: '',
      })),
    });
    // As in the store: a subtask is queued behind the work in flight, not started.
    if (options.parent !== undefined) state.status = 'pending';
    const task: StoredTask = {
      meta: {
        id,
        createdAt: at,
        updatedAt: at,
        path: `.state3/${id}.json`,
        skill: options.skill ?? 'dev-task',
        notation: options.notation ?? 'plain',
        parent: options.parent ?? null,
      },
      state: asDict(state),
    };
    this.tasks.push(task);
    return task;
  }

  async show(id?: string): Promise<StoredTask> {
    this.calls.push(`show|${id ?? '-'}`);
    if (this.showFailure !== null) throw this.showFailure;
    const found = this.resolve(id);
    if (found === null) {
      throw new FakeTaskNotFoundError(
        id === undefined ? 'No active task found' : `No task found with id "${id}"`,
      );
    }
    return found;
  }

  async patch(patch: StateDict, id?: string, report?: PatchReport): Promise<StoredTask> {
    this.calls.push(`patch|${JSON.stringify(patch)}|${id ?? '-'}`);
    if (this.patchFailure !== null) throw this.patchFailure;
    const found = this.resolve(id);
    if (found === null) throw new FakeTaskNotFoundError('No active task found');
    this.entries.push({ at: this.stamp(), patch, ok: true });
    // `parent` addresses the tree rather than Σ, so it never reaches the merged state — as in the
    // store. The fake applies the move without re-checking it; the refusals are tested there.
    const statePatch: StateDict = { ...patch };
    const movesTree = 'parent' in statePatch;
    const requested = statePatch['parent'];
    delete statePatch['parent'];
    if (movesTree) {
      const from = found.meta.parent;
      const to = typeof requested === 'string' && requested.trim() !== '' ? requested.trim() : null;
      found.meta.parent = to;
      if (report !== undefined && from !== to) report.moved = { from, to };
    }
    const merged: DevTaskState = {
      ...this.dev(found),
      ...(statePatch as Partial<DevTaskState>),
    };
    const before = found.state;
    found.state = asDict(merged);
    found.meta.updatedAt = this.stamp();
    if (report !== undefined) {
      // The log entries a wholesale replacement dropped, by the same function the store uses.
      const dropped = droppedDecisions(before, found.state);
      if (dropped !== null) report.dropped = dropped;
    }
    return found;
  }

  async finish(summary: string, id?: string, report?: FinishReport): Promise<StoredTask> {
    this.calls.push(`finish|${summary}|${id ?? '-'}`);
    const found = this.resolve(id);
    if (found === null) throw new FakeTaskNotFoundError('No active task found');
    const state = this.dev(found);
    state.status = 'done';
    state.next = { action: summary, risk: 'safe' };
    state.decisions = [...state.decisions, summary];
    found.state = asDict(state);
    found.meta.updatedAt = this.stamp();
    if (report !== undefined) {
      const handed = this.handOver(found);
      if (handed !== null) report.handedOver = handed;
    }
    return found;
  }

  /**
   * The queue handover, as the store does it: the first sibling still queued, unless another is
   * already in flight. The fake does not re-check the tree — that belongs to the store's tests.
   */
  private handOver(closed: StoredTask): Handover | null {
    const parent = closed.meta.parent;
    if (parent === null) return null;
    const siblings = this.tasks.filter((other) => other !== closed && other.meta.parent === parent);
    if (siblings.some((other) => this.dev(other).status === 'active')) return null;
    const next = siblings.find((other) => this.dev(other).status === 'pending');
    if (next === undefined) return null;
    const state = this.dev(next);
    state.status = 'active';
    next.state = asDict(state);
    return { id: next.meta.id, goal: state.goal };
  }

  async list(): Promise<TaskSummary[]> {
    this.calls.push('list');
    const summaries = this.tasks.map((t) => {
      const state = this.dev(t);
      return {
        id: t.meta.id,
        goal: state.goal,
        status: state.status,
        skill: t.meta.skill,
        updatedAt: t.meta.updatedAt,
        createdAt: t.meta.createdAt,
        seq: this.tasks.indexOf(t),
        progressDone: state.plan.filter((p) => p.status === 'done').length,
        progressTotal: state.plan.length,
        parent: t.meta.parent,
      };
    });
    return summaries.map((summary) => {
      const children = summaries.filter((other) => other.parent === summary.id);
      return {
        ...summary,
        subtasks: children.length,
        openSubtasks: children.filter((child) => child.status !== 'done').length,
      };
    });
  }

  async history(id?: string, limit?: number): Promise<HistoryEntry[]> {
    this.calls.push(`history|${id ?? '-'}|${limit === undefined ? '-' : String(limit)}`);
    if (id !== undefined && this.resolve(id) === null) {
      throw new FakeTaskNotFoundError(`No task found with id "${id}"`);
    }
    return limit === undefined ? [...this.entries] : this.entries.slice(-limit);
  }

  async activeId(): Promise<string | null> {
    const active = this.tasks.filter((t) => this.dev(t).status === 'active').pop();
    return active?.meta.id ?? null;
  }

  private resolve(id?: string): StoredTask | null {
    if (id !== undefined) return this.tasks.find((t) => t.meta.id === id) ?? null;
    return this.tasks.filter((t) => this.dev(t).status === 'active').pop() ?? null;
  }
}

function makeDeps(
  store: FakeStore,
  options: { stdin?: string } = {},
): {
  deps: TaskCliDeps;
  lines: string[];
  roots: string[];
} {
  const lines: string[] = [];
  const roots: string[] = [];
  const deps: TaskCliDeps = {
    createStore: (root) => {
      roots.push(root);
      return store;
    },
    readStdin: async () => options.stdin ?? '',
    log: (message) => lines.push(message),
  };
  return { deps, lines, roots };
}

const PROJECTS_VAR = 'STATE3_PROJECTS';
const cwd = process.cwd();
const workerRoot = resolve(cwd, 'state/worker');
const reviewRoot = resolve(cwd, 'state/review');
let savedProjects: string | undefined;

afterEach(() => {
  if (savedProjects === undefined) delete process.env[PROJECTS_VAR];
  else process.env[PROJECTS_VAR] = savedProjects;
  savedProjects = undefined;
});

describe('parseTaskArgs', () => {
  it('parses start with a goal and repeated plan flags', () => {
    expect(
      parseTaskArgs(['start', 'Refactor auth', '--plan', 'Read code', '--plan', 'Write tests']),
    ).toEqual({
      root: '.state3',
      subcommand: 'start',
      goal: 'Refactor auth',
      plan: ['Read code', 'Write tests'],
      confirm: [],
      id: null,
      patch: null,
      summary: null,
      limit: null,
      skill: null,
      notation: null,
      parent: null,
      tree: false,
      project: null,
      purge: false,
      fromStdin: false,
      help: false,
    });
  });

  it('parses every subcommand with its own arguments', () => {
    expect(parseTaskArgs(['show'])).toMatchObject({ subcommand: 'show', id: null });
    expect(parseTaskArgs(['show', '--id', 'task-1'])).toMatchObject({
      subcommand: 'show',
      id: 'task-1',
    });
    expect(parseTaskArgs(['patch', '{"status":"blocked"}'])).toMatchObject({
      subcommand: 'patch',
      patch: { status: 'blocked' },
    });
    expect(parseTaskArgs(['patch', '-'])).toMatchObject({
      subcommand: 'patch',
      patch: null,
      fromStdin: true,
    });
    expect(parseTaskArgs(['finish', 'Shipped the refactor'])).toMatchObject({
      subcommand: 'finish',
      summary: 'Shipped the refactor',
    });
    expect(parseTaskArgs(['list'])).toMatchObject({ subcommand: 'list' });
    expect(parseTaskArgs(['history', '--limit', '5'])).toMatchObject({
      subcommand: 'history',
      limit: 5,
    });
  });

  it('parses --root for any subcommand', () => {
    expect(parseTaskArgs(['--root', 'build/state', 'list'])).toMatchObject({ root: 'build/state' });
    expect(parseTaskArgs(['list', '--root', 'build/state'])).toMatchObject({ root: 'build/state' });
  });

  it('parses --skill and --notation for start', () => {
    expect(
      parseTaskArgs(['start', 'Review the worker', '--skill', 'supervise-task']),
    ).toMatchObject({
      subcommand: 'start',
      goal: 'Review the worker',
      skill: 'supervise-task',
      notation: null,
    });
    expect(parseTaskArgs(['start', 'Ship it', '--notation', 'compact'])).toMatchObject({
      notation: 'compact',
      skill: null,
    });
    expect(parseTaskArgs(['start', 'Ship it', '--notation', 'plain'])).toMatchObject({
      notation: 'plain',
    });
    expect(
      parseTaskArgs([
        'start',
        'Ship it',
        '--skill',
        'supervise-task',
        '--notation',
        'compact',
        '--plan',
        'a',
      ]),
    ).toMatchObject({ skill: 'supervise-task', notation: 'compact', plan: ['a'] });
  });

  it('rejects an unknown notation and lists the valid ones', () => {
    expect(() => parseTaskArgs(['start', 'Ship it', '--notation', 'haiku'])).toThrow(
      /--notation expects one of: plain, compact/,
    );
    expect(() => parseTaskArgs(['start', 'Ship it', '--notation', 'COMPACT'])).toThrow(
      /--notation expects one of/,
    );
  });

  it('rejects --skill and --notation on any other subcommand', () => {
    expect(() => parseTaskArgs(['show', '--skill', 'dev-task'])).toThrow(
      /--skill is only valid for task start/,
    );
    expect(() => parseTaskArgs(['patch', '{"status":"blocked"}', '--skill', 'dev-task'])).toThrow(
      /--skill is only valid for task start/,
    );
    expect(() => parseTaskArgs(['list', '--notation', 'compact'])).toThrow(
      /--notation is only valid for task start/,
    );
  });

  it('rejects --parent on any other subcommand, and names the patch that moves a task', () => {
    expect(() => parseTaskArgs(['patch', '{"status":"blocked"}', '--parent', 'task-1'])).toThrow(
      /--parent is only valid for task start/,
    );
    // The flag is refused, but what it was reaching for is available one level down: a refusal
    // that does not say so reads as "a task cannot be moved at all".
    expect(() => parseTaskArgs(['show', '--parent', 'task-1'])).toThrow(
      /patch it with '\{"parent":"<task id>"\}'/,
    );
  });

  it('rejects a missing value for --skill, --notation and --project', () => {
    expect(() => parseTaskArgs(['start', 'Ship it', '--skill'])).toThrow(
      /Missing value for --skill/,
    );
    expect(() => parseTaskArgs(['start', 'Ship it', '--notation'])).toThrow(
      /Missing value for --notation/,
    );
    expect(() => parseTaskArgs(['list', '--project'])).toThrow(/Missing value for --project/);
  });

  it('parses --project for any subcommand and rejects it next to --root', () => {
    expect(parseTaskArgs(['list', '--project', 'worker'])).toMatchObject({
      subcommand: 'list',
      project: 'worker',
      root: '.state3',
    });
    expect(parseTaskArgs(['--project', 'worker', 'show'])).toMatchObject({ project: 'worker' });
    expect(() => parseTaskArgs(['--root', 'build/state', 'list', '--project', 'worker'])).toThrow(
      /--project already picks a declared state root, so --root is redundant/,
    );
    expect(() => parseTaskArgs(['list', '--project', 'worker', '--root', 'x'])).toThrow(
      /--root is redundant/,
    );
  });

  it('rejects missing and unknown subcommands', () => {
    expect(() => parseTaskArgs([])).toThrow(/Missing task subcommand/);
    expect(() => parseTaskArgs(['drop'])).toThrow(/Unknown task subcommand: drop/);
    expect(() => parseTaskArgs(['drop'])).toThrow(/start, show, patch, finish, list, history/);
  });

  it('rejects missing required positional arguments', () => {
    expect(() => parseTaskArgs(['start'])).toThrow(/task start requires a goal argument/);
    expect(() => parseTaskArgs(['patch'])).toThrow(/task patch requires a JSON patch argument/);
    expect(() => parseTaskArgs(['finish'])).toThrow(/task finish requires a summary argument/);
  });

  it('rejects positional arguments where they are not allowed', () => {
    expect(() => parseTaskArgs(['show', 'extra'])).toThrow(/Unexpected argument: extra/);
    expect(() => parseTaskArgs(['list', 'extra'])).toThrow(/Unexpected argument: extra/);
    expect(() => parseTaskArgs(['start', 'goal', 'extra'])).toThrow(/Unexpected argument: extra/);
  });

  it('rejects unknown flags and missing flag values', () => {
    expect(() => parseTaskArgs(['list', '--nope'])).toThrow(/Unknown argument: --nope/);
    expect(() => parseTaskArgs(['list', '--root'])).toThrow(/Missing value for --root/);
    expect(() => parseTaskArgs(['history', '--limit'])).toThrow(/Missing value for --limit/);
    expect(() => parseTaskArgs(['history', '--limit', '0'])).toThrow(/integer >= 1/);
    expect(() => parseTaskArgs(['history', '--limit', 'x'])).toThrow(/integer >= 1/);
  });

  it('rejects flags that do not belong to the subcommand', () => {
    expect(() => parseTaskArgs(['show', '--limit', '3'])).toThrow(
      /--limit is only valid for task history/,
    );
    expect(() => parseTaskArgs(['show', '--plan', 'x'])).toThrow(
      /--plan is only valid for task start/,
    );
    expect(() => parseTaskArgs(['list', '--id', 'task-1'])).toThrow(
      /--id is not valid for task list/,
    );
    expect(() => parseTaskArgs(['start', 'goal', '--id', 'task-1'])).toThrow(
      /--id is not valid for task start/,
    );
  });

  it('rejects malformed patch JSON', () => {
    expect(() => parseTaskArgs(['patch', '{oops'])).toThrow(/patch must be valid JSON/);
    expect(() => parseTaskArgs(['patch', '[1,2]'])).toThrow(/patch must be a JSON object/);
    expect(() => parseTaskArgs(['patch', 'null'])).toThrow(/patch must be a JSON object/);
    expect(() => parseTaskArgs(['patch', '"done"'])).toThrow(/patch must be a JSON object/);
  });
});

describe('resolveTaskRoot', () => {
  const env = { [PROJECTS_VAR]: `worker=${workerRoot};review=${reviewRoot}` };

  it('resolves --root when no project is named', () => {
    expect(resolveTaskRoot(parseTaskArgs(['list']), {})).toBe(resolve('.state3'));
    expect(resolveTaskRoot(parseTaskArgs(['--root', 'build/state', 'list']), {})).toBe(
      resolve('build/state'),
    );
  });

  it('ignores the declared projects when no project is named', () => {
    expect(resolveTaskRoot(parseTaskArgs(['list']), env)).toBe(resolve('.state3'));
  });

  it('looks a named project up in STATE3_PROJECTS', () => {
    expect(resolveTaskRoot(parseTaskArgs(['list', '--project', 'worker']), env)).toBe(workerRoot);
    expect(resolveTaskRoot(parseTaskArgs(['show', '--project', 'review']), env)).toBe(reviewRoot);
  });

  it('accepts the JSON form of STATE3_PROJECTS', () => {
    const json = { [PROJECTS_VAR]: JSON.stringify({ worker: workerRoot }) };
    expect(resolveTaskRoot(parseTaskArgs(['list', '--project', 'worker']), json)).toBe(workerRoot);
  });

  it('resolves a relative declared directory against the process cwd', () => {
    const relative = { [PROJECTS_VAR]: 'worker=state/worker' };
    expect(resolveTaskRoot(parseTaskArgs(['list', '--project', 'worker']), relative)).toBe(
      resolve(cwd, 'state/worker'),
    );
  });

  it('throws when the environment declares no projects', () => {
    const options = parseTaskArgs(['list', '--project', 'worker']);
    expect(() => resolveTaskRoot(options, {})).toThrow(
      /--project needs STATE3_PROJECTS to declare project roots/,
    );
    expect(() => resolveTaskRoot(options, { [PROJECTS_VAR]: '   ' })).toThrow(
      /--project needs STATE3_PROJECTS/,
    );
  });

  it('throws for an unknown project name and lists the declared ones', () => {
    const options = parseTaskArgs(['list', '--project', 'nope']);
    expect(() => resolveTaskRoot(options, env)).toThrow(/unknown project "nope"/);
    expect(() => resolveTaskRoot(options, env)).toThrow(`worker (${workerRoot})`);
    expect(() => resolveTaskRoot(options, env)).toThrow(`review (${reviewRoot})`);
  });
});

describe('runTaskCommand', () => {
  it('starts a task and prints the compact state', async () => {
    const store = new FakeStore();
    const { deps, lines, roots } = makeDeps(store);

    await runTaskCommand(
      parseTaskArgs(['start', 'Migrate to zod 4', '--plan', 'Read usages', '--root', '.state3']),
      deps,
    );

    expect(roots).toEqual([resolve('.state3')]);
    expect(store.calls[0]).toBe('start|Migrate to zod 4|Read usages|-|-');
    expect(store.startOptions[0]).toEqual({ plan: ['Read usages'] });
    expect(lines[0]).toContain('Task task-1 [dev-task] (active):');
    expect(lines[0]).toContain('"goal":"Migrate to zod 4"');
    expect(lines[0]).not.toContain('\n  ');
    expect(lines[1]).toContain('state3 task patch');
  });

  it('demonstrates a path patch in the start hint', async () => {
    const store = new FakeStore();
    const { deps, lines } = makeDeps(store);

    await runTaskCommand(parseTaskArgs(['start', 'Ship it']), deps);

    expect(lines[1]).toContain('"plan[0].status":"done"');
    expect(lines[1]).toContain('"next":{"action":"...","risk":"safe"}');
  });

  it('forwards skill, notation and plan to the store', async () => {
    const store = new FakeStore();
    const { deps, lines } = makeDeps(store);

    await runTaskCommand(
      parseTaskArgs([
        'start',
        'Review the worker',
        '--skill',
        'supervise-task',
        '--notation',
        'compact',
        '--plan',
        'Read the diff',
      ]),
      deps,
    );

    expect(store.calls[0]).toBe('start|Review the worker|Read the diff|supervise-task|compact');
    expect(store.startOptions[0]).toEqual({
      plan: ['Read the diff'],
      skill: 'supervise-task',
      notation: 'compact',
    });
    expect(lines[0]).toContain('Task task-1 [supervise-task] (active):');
  });

  it('starts a task without a plan', async () => {
    const store = new FakeStore();
    const { deps } = makeDeps(store);

    await runTaskCommand(parseTaskArgs(['start', 'Fix flaky test']), deps);

    expect(store.calls[0]).toBe('start|Fix flaky test|-|-|-');
    expect(store.startOptions[0]).toEqual({});
  });

  it('shows the most recently updated active task by default and an explicit task by id', async () => {
    const store = new FakeStore();
    const { deps, lines } = makeDeps(store);
    await store.start('First goal');
    await store.start('Second goal');

    await runTaskCommand(parseTaskArgs(['show']), deps);
    await runTaskCommand(parseTaskArgs(['show', '--id', 'task-1']), deps);

    expect(store.calls).toContain('show|-');
    expect(store.calls).toContain('show|task-1');
    expect(lines[0]).toContain('Task task-2 [dev-task] (active):');
    expect(lines[0]).toContain('"goal":"Second goal"');
    expect(lines[1]).toContain('Task task-1 [dev-task] (active):');
    expect(lines[1]).toContain('"goal":"First goal"');
  });

  it('patches the active task and prints the merged state', async () => {
    const store = new FakeStore();
    const { deps, lines } = makeDeps(store);
    await store.start('Refactor the importer');

    await runTaskCommand(parseTaskArgs(['patch', '{"status":"blocked"}']), deps);

    expect(store.calls).toContain('patch|{"status":"blocked"}|-');
    expect(lines[0]).toContain('Task task-1 [dev-task] (blocked):');
    expect(lines[0]).toContain('"status":"blocked"');
  });

  it('moves a task in the tree with a parent patch, and says so', async () => {
    const store = new FakeStore();
    const { deps, lines } = makeDeps(store);
    await store.start('The decomposition');
    await store.start('A piece of it', { parent: 'task-1' });

    await runTaskCommand(parseTaskArgs(['patch', '{"parent":null}', '--id', 'task-2']), deps);

    expect(store.tasks[1]?.meta.parent).toBeNull();
    expect(lines[1]).toContain('Moved out of task-1 into a root task');
    // The key addressed the tree, so Σ gained nothing to show for it — the printed state reads
    // exactly as it did before the move, which is why the line below it is not optional.
    expect(lines[0]).not.toContain('parent');
  });

  it('prints the piece the queue moved on to when a finish hands over', async () => {
    const store = new FakeStore();
    const { deps, lines } = makeDeps(store);
    await store.start('The decomposition');
    await store.start('Piece one', { parent: 'task-1' });
    await store.start('Piece two', { parent: 'task-1' });

    await runTaskCommand(parseTaskArgs(['finish', 'piece one done', '--id', 'task-2']), deps);

    // The state printed above the line is the closed task's, which cannot say what is in flight
    // now — the promotion happened to another row.
    expect(lines.at(-1)).toContain('Handed over to task-3 — "Piece two"');
  });

  it('prints what a patch cost Σ, which the state itself does not show', async () => {
    const store = new FakeStore();
    const { deps, lines } = makeDeps(store);
    await store.start('Refactor the importer');
    await runTaskCommand(
      parseTaskArgs(['patch', '{"decisions":["used stdio","kept the legacy root"]}']),
      deps,
    );

    await runTaskCommand(parseTaskArgs(['patch', '{"decisions":["kept the legacy root"]}']), deps);

    // The printed Σ holds only what survived, so this line is the only thing on this surface that
    // says an entry left — the same wording the tool answer carries.
    expect(lines.at(-1)).toContain('1 decisions entry(s) are no longer in Σ (2 -> 1)');
    expect(lines.at(-1)).toContain('"used stdio"');
  });

  it('reads the patch from stdin when the argument is a dash', async () => {
    const store = new FakeStore();
    const { deps } = makeDeps(store, { stdin: '{"next":{"action":"Run tests","risk":"safe"}}' });
    await store.start('Refactor the importer');

    await runTaskCommand(parseTaskArgs(['patch', '-']), deps);

    expect(store.calls[1]).toBe('patch|{"next":{"action":"Run tests","risk":"safe"}}|-');
  });

  it('rejects malformed stdin JSON', async () => {
    const store = new FakeStore();
    const { deps } = makeDeps(store, { stdin: '{not json' });
    await store.start('Refactor the importer');

    await expect(runTaskCommand(parseTaskArgs(['patch', '-']), deps)).rejects.toThrow(
      /patch must be valid JSON/,
    );
    expect(store.calls.filter((c) => c.startsWith('patch|'))).toEqual([]);
  });

  it('reports a rejected patch with its validation category', async () => {
    const store = new FakeStore();
    store.patchFailure = new FakeTaskPatchError(
      'guard',
      'plan item 2 is done; add notes to reopen it',
    );
    const { deps, lines } = makeDeps(store);
    await store.start('Refactor the importer');

    await expect(runTaskCommand(parseTaskArgs(['patch', '{"plan":[]}']), deps)).rejects.toThrow(
      'patch rejected (guard): plan item 2 is done; add notes to reopen it',
    );
    expect(lines).toEqual([]);
  });

  it('reports a rejected path patch with the path category', async () => {
    const store = new FakeStore();
    store.patchFailure = new FakeTaskPatchError('path', 'index 7 in "plan[7]" is out of range');
    const { deps } = makeDeps(store);
    await store.start('Refactor the importer');

    await expect(
      runTaskCommand(parseTaskArgs(['patch', '{"plan[7].status":"done"}']), deps),
    ).rejects.toThrow('patch rejected (path): index 7 in "plan[7]" is out of range');
  });

  it('passes through a not-found failure message', async () => {
    const store = new FakeStore();
    const { deps } = makeDeps(store);

    await expect(runTaskCommand(parseTaskArgs(['show']), deps)).rejects.toThrow(
      'No active task found',
    );
  });

  it('wraps a non-Error failure into the message', async () => {
    const store = new FakeStore();
    store.showFailure = 'disk on fire' as unknown as Error;
    const { deps } = makeDeps(store);

    await expect(runTaskCommand(parseTaskArgs(['show']), deps)).rejects.toThrow('disk on fire');
  });

  it('finishes the active task and prints the done state', async () => {
    const store = new FakeStore();
    const { deps, lines } = makeDeps(store);
    await store.start('Ship the integration');

    await runTaskCommand(parseTaskArgs(['finish', 'MCP server shipped']), deps);

    expect(store.calls).toContain('finish|MCP server shipped|-');
    expect(lines[0]).toContain('Task task-1 [dev-task] (done):');
    expect(lines[0]).toContain('"action":"MCP server shipped"');
  });

  it('lists tasks with skill and progress and handles an empty store', async () => {
    const store = new FakeStore();
    const { deps, lines } = makeDeps(store);

    await runTaskCommand(parseTaskArgs(['list']), deps);
    expect(lines[0]).toBe('no tasks');
    // Every list ends with the build that answered, so a stale host is visible.
    expect(lines[1]).toMatch(/^runtime: state3 \S+ \(/);

    await store.start('Goal one', { plan: ['step a', 'step b'] });
    await runTaskCommand(parseTaskArgs(['list']), deps);
    expect(lines[2]).toContain('task-1');
    expect(lines[2]).toContain('dev-task');
    expect(lines[2]).toContain('active');
    expect(lines[2]).toContain('0/2');
    expect(lines[2]).toContain('Goal one');
    expect(lines[3]).toMatch(/^runtime: state3 /);
  });

  it('prints the help for --help and -h without touching any store', async () => {
    const store = new FakeStore();
    const { deps, lines, roots } = makeDeps(store);

    await runTaskCommand(parseTaskArgs(['--help']), deps);
    expect(roots).toEqual([]);
    expect(store.calls).toEqual([]);
    expect(lines[0]).toContain('state3 task <subcommand>');
    expect(lines[0]).toContain('start');
    expect(lines[0]).toContain('--notation');

    await runTaskCommand(parseTaskArgs(['-h']), deps);
    expect(lines[1]).toBe(lines[0]);

    // A subcommand may carry the flag too: `task show --help`.
    await runTaskCommand(parseTaskArgs(['show', '--help']), deps);
    expect(lines[2]).toBe(lines[0]);
    expect(roots).toEqual([]);
  });

  it('documents every subcommand and accepts every flag it advertises', () => {
    const text = taskHelpText();
    for (const name of TASK_SUBCOMMANDS) {
      expect(text, `help omits subcommand "${name}"`).toContain(name);
    }
    for (const flag of HELP_FLAGS) {
      expect(text, `help omits flag ${flag}`).toContain(flag);
      let message = '';
      try {
        parseTaskArgs(['start', 'Ship it', flag, 'value']);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      // Any complaint but "Unknown argument" is fine: the flag is really parsed.
      expect(message, `help advertises ${flag}, which the parser rejects`).not.toContain(
        'Unknown argument',
      );
    }
  });

  it('opens the declared project root when --project is given', async () => {
    savedProjects = process.env[PROJECTS_VAR];
    process.env[PROJECTS_VAR] = `worker=${workerRoot}`;
    const store = new FakeStore();
    const { deps, roots } = makeDeps(store);

    await runTaskCommand(parseTaskArgs(['list', '--project', 'worker']), deps);

    expect(roots).toEqual([workerRoot]);
    expect(store.calls).toContain('list');
  });

  it('reports an unknown --project instead of writing to the default root', async () => {
    savedProjects = process.env[PROJECTS_VAR];
    process.env[PROJECTS_VAR] = `worker=${workerRoot}`;
    const store = new FakeStore();
    const { deps, roots } = makeDeps(store);

    await expect(
      runTaskCommand(parseTaskArgs(['list', '--project', 'nope']), deps),
    ).rejects.toThrow(/unknown project "nope"/);
    expect(roots).toEqual([]);
  });

  it('prints history including rejected patches and honours limit and id', async () => {
    const store = new FakeStore();
    const { deps, lines } = makeDeps(store);
    await store.start('Goal one');
    store.entries.push(
      {
        at: '2026-09-05T00:00:01Z',
        patch: { status: 'blocked' },
        ok: false,
        error: { category: 'guard', message: 'needs blockers' },
      },
      { at: '2026-09-05T00:00:02Z', patch: { decisions: ['chose zod'] }, ok: true },
    );

    await runTaskCommand(parseTaskArgs(['history']), deps);
    expect(store.calls).toContain('history|-|-');
    expect(lines[0]).toContain('rejected (guard: needs blockers)');
    expect(lines[0]).toContain('{"status":"blocked"}');

    await runTaskCommand(parseTaskArgs(['history', '--id', 'task-1', '--limit', '1']), deps);
    expect(store.calls).toContain('history|task-1|1');
    expect(lines[1]).toContain('{"decisions":["chose zod"]}');
    expect(lines[1]).not.toContain('rejected');
  });

  it('records a path patch in history exactly as it was sent', async () => {
    const store = new FakeStore();
    const { deps, lines } = makeDeps(store);
    await store.start('Goal one');

    await runTaskCommand(parseTaskArgs(['patch', '{"plan[0].status":"done"}']), deps);
    await runTaskCommand(parseTaskArgs(['history']), deps);

    expect(lines[1]).toContain('{"plan[0].status":"done"}');
  });

  it('prints "no history" for a fresh task', async () => {
    const store = new FakeStore();
    const { deps, lines } = makeDeps(store);
    await store.start('Goal one');

    await runTaskCommand(parseTaskArgs(['history']), deps);

    expect(lines[0]).toBe('no history');
  });
});

describe('formatters', () => {
  const rows: TaskSummary[] = [
    {
      id: 'task-1',
      goal: 'Ship the integration',
      status: 'active',
      skill: 'dev-task',
      updatedAt: '2026-09-05T00:00:01Z',
      createdAt: '2026-09-05T00:00:00Z',
      seq: 0,
      progressDone: 1,
      progressTotal: 2,
      parent: null,
      subtasks: 0,
      openSubtasks: 0,
    },
    {
      id: 'task-2',
      goal: 'Review the worker',
      status: 'done',
      skill: 'supervise-task',
      updatedAt: '2026-09-05T00:00:02Z',
      createdAt: '2026-09-05T00:00:01Z',
      seq: 1,
      progressDone: 3,
      progressTotal: 3,
      parent: null,
      subtasks: 0,
      openSubtasks: 0,
    },
  ];

  it('formatTaskList and formatHistory handle empty inputs', () => {
    expect(formatTaskList([])).toBe('no tasks');
    expect(formatHistory([])).toBe('no history');
  });

  it('formatTaskList prints id, skill, status, progress and goal in padded columns', () => {
    expect(formatTaskList(rows)).toBe(
      [
        `task-1  ${'dev-task'.padEnd(14)}  ${'active'.padEnd(7)}  1/2  Ship the integration`,
        `task-2  ${'supervise-task'.padEnd(14)}  ${'done'.padEnd(7)}  3/3  Review the worker`,
      ].join('\n'),
    );
  });

  it('formatTaskList aligns the columns of tasks with different skill names', () => {
    const lines = formatTaskList(rows).split('\n');
    const columnOf = (line: string, text: string): number => line.indexOf(text);
    expect(columnOf(lines[0] ?? '', 'active')).toBe(columnOf(lines[1] ?? '', 'done'));
    expect(columnOf(lines[0] ?? '', '1/2')).toBe(columnOf(lines[1] ?? '', '3/3'));
    expect(lines[0]).toContain('dev-task');
    expect(lines[1]).toContain('supervise-task');
  });

  it('formatTaskList keeps a long skill name readable without breaking the row', () => {
    const line = formatTaskList([{ ...rows[0]!, skill: 'a-very-long-skill-name' }]).split('\n')[0];
    expect(line).toBe(
      `task-1  a-very-long-skill-name  ${'active'.padEnd(7)}  1/2  Ship the integration`,
    );
    expect(line).toContain('a-very-long-skill-name');
  });

  /** A root split into two queued subtasks, newest first as list() returns them. */
  const tree: TaskSummary[] = [
    {
      ...rows[1]!,
      id: 'task-b2',
      goal: 'Second piece',
      status: 'pending',
      skill: 'dev-task',
      createdAt: '2026-09-05T00:00:03Z',
      seq: 3,
      progressDone: 0,
      progressTotal: 0,
      parent: 'task-1',
      subtasks: 0,
      openSubtasks: 0,
    },
    {
      ...rows[1]!,
      id: 'task-b1',
      goal: 'First piece',
      status: 'pending',
      skill: 'dev-task',
      createdAt: '2026-09-05T00:00:02Z',
      seq: 2,
      progressDone: 0,
      progressTotal: 0,
      parent: 'task-1',
      subtasks: 0,
      openSubtasks: 0,
    },
    { ...rows[0]!, subtasks: 2, openSubtasks: 2 },
  ];

  it('formatTaskList indents subtasks under the task they were split out of', () => {
    const lines = formatTaskList(tree).split('\n');

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('task-1');
    expect(lines[0]).toContain('(2 subtasks, 2 open)');
    expect(lines[0]).not.toMatch(/^\s/);
    // Newest-first rows go back into the order the work was decomposed in.
    expect(lines[1]).toContain('task-b1');
    expect(lines[1]).toMatch(/^ {2}- /);
    expect(lines[2]).toContain('task-b2');
  });

  it('formatTaskList prints an orphan as a root instead of dropping it', () => {
    const text = formatTaskList([{ ...rows[0]!, id: 'task-x', parent: 'task-gone' }]);

    expect(text).toContain('task-x');
    expect(text).not.toContain('task-gone');
  });

  it('formatSubtree prints one decomposition and leaves another root out', async () => {
    const store = new FakeStore();
    const root = await store.start('Ship the release', {});
    await store.start('First piece', { parent: root.meta.id });
    await store.start('Unrelated work', {});

    const text = await formatSubtree(store as unknown as TaskStorePort, root.meta.id);

    expect(text).toContain('Ship the release');
    expect(text).toContain('First piece');
    expect(text).not.toContain('Unrelated work');
  });

  it('formatHistory prints one line per entry with the rejected category', () => {
    const entries: HistoryEntry[] = [
      { at: 'a1', patch: { decisions: ['x'] }, ok: true },
      {
        at: 'a2',
        patch: { bogus: 1 },
        ok: false,
        error: { category: 'unknown-key', message: 'no' },
      },
    ];
    expect(formatHistory(entries)).toBe(
      ['a1  ok  {"decisions":["x"]}', 'a2  rejected (unknown-key: no)  {"bogus":1}'].join('\n'),
    );
  });
});
