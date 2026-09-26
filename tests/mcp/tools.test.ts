import { describe, expect, it } from 'vitest';
import { REJECT_CATEGORIES } from '../../src/core/rejections.js';
import { expandPathPatch, mergeState } from '../../src/core/state.js';
import type { StateDict, StateValue } from '../../src/core/types.js';
import {
  classifyError,
  createTaskTools,
  renderState,
  renderStateWithProcedure,
} from '../../src/mcp/tools.js';
import type { TaskStorePort, TaskToolDefinition, ToolResult } from '../../src/mcp/tools.js';
import type { Notation } from '../../src/tasks/notation.js';
import type { ProjectEntry } from '../../src/tasks/ports.js';
import { createProjectResolver, singleStoreResolver } from '../../src/tasks/projects.js';
import type { DriftedArtifact } from '../../src/tasks/artifact-stamps.js';
import type {
  HistoryEntry,
  PatchReport,
  StartOptions,
  StoredTask,
  TaskSummary,
} from '../../src/tasks/store.js';
import type { StampReport } from '../../src/tasks/verifications.js';

type Dict = Record<string, unknown>;

const INSTRUCTIONS =
  'Patch the state after every meaningful step; call task_show after compaction.';

/** Skills the fake knows, mirroring the builtin registry. */
const SKILLS = ['dev-task', 'supervise-task'];
const NOTATIONS = ['plain', 'compact'];

interface FakeErrors {
  show?: unknown;
  patch?: unknown;
  finish?: unknown;
  list?: unknown;
  history?: unknown;
}

interface FakeStoreOptions {
  rootDir?: string;
  /** `null` means the store does not expose the optional `skillNames` method. */
  skills?: readonly string[] | null;
}

/** Mirrors the shape of the real errors without importing them as values. */
class FakeNotFoundError extends Error {
  override readonly name = 'TaskNotFoundError';
}

class FakePatchError extends Error {
  override readonly name = 'TaskPatchError';
  readonly category: string;
  constructor(category: string, message: string) {
    super(message);
    this.category = category;
  }
}

/**
 * Structural stand-in for `TaskStore`: assigning it to a `TaskStorePort` is a
 * compile-time check that the fake still matches the port.
 */
class FakeTaskStore {
  readonly rootDir: string;
  readonly tasks: StoredTask[] = [];
  readonly entries: HistoryEntry[] = [];
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  errors: FakeErrors = {};
  /** Procedure P returned by `instructionsFor`; blank means "this task has no P". */
  instructions = INSTRUCTIONS;
  readonly skillNames?: () => string[];
  private counter = 0;

  constructor(options: FakeStoreOptions = {}) {
    this.rootDir = options.rootDir ?? '/fake/project/.state3';
    const skills = options.skills === undefined ? SKILLS : options.skills;
    if (skills !== null) {
      const names = [...skills];
      this.skillNames = () => [...names];
    }
  }

  callCount(method: string): number {
    return this.calls.filter((call) => call.method === method).length;
  }

  calledWith(method: string): unknown[] | undefined {
    return this.calls.find((call) => call.method === method)?.args;
  }

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
  }

  private resolve(id: string | undefined, emptyMessage: string): StoredTask {
    if (id !== undefined) {
      const found = this.tasks.find((task) => task.meta.id === id);
      if (found === undefined) throw new FakeNotFoundError(`task not found: ${id}`);
      return found;
    }
    const open = [...this.tasks].reverse().find((task) => task.state['status'] !== 'done');
    const task = open ?? this.tasks[this.tasks.length - 1];
    if (task === undefined) throw new FakeNotFoundError(emptyMessage);
    return task;
  }

  /** Σ_0 per skill: the point of the fake is that each skill brings its own shape. */
  private initialState(goal: string, skill: string, plan: readonly string[]): StateDict {
    const base: StateDict = {
      goal,
      status: 'active',
      decisions: [],
      blockers: [],
      next: { action: 'start working', risk: 'safe' },
    };
    if (skill === 'supervise-task') {
      return { ...base, spec: '', worker: '', rounds: [] };
    }
    return {
      ...base,
      plan: plan.map((text, index) => ({
        id: String(index + 1),
        task: text,
        status: 'pending',
        notes: '',
      })),
      artifacts: {},
      verifications: [],
    };
  }

  async start(goal: string, options: StartOptions = {}): Promise<StoredTask> {
    this.record('start', [goal, options]);
    const skill = options.skill ?? SKILLS[0] ?? 'dev-task';
    if (!SKILLS.includes(skill)) {
      throw new FakePatchError(
        'skill',
        `unknown skill "${skill}" (available: ${SKILLS.join(', ')})`,
      );
    }
    const notation: Notation = options.notation ?? 'plain';
    this.counter += 1;
    const id = `task-${this.counter}`;
    const at = '2026-09-05T10:00:00.000Z';
    const task: StoredTask = {
      meta: {
        id,
        createdAt: at,
        updatedAt: at,
        path: `.state3/${id}.json`,
        skill,
        notation,
        parent: options.parent ?? null,
      },
      state: this.initialState(goal, skill, options.plan ?? []),
    };
    this.tasks.push(task);
    return task;
  }

  async show(id?: string): Promise<StoredTask> {
    this.record('show', [id]);
    if (this.errors.show !== undefined) throw this.errors.show;
    return this.resolve(id, 'no active task');
  }

  /** What `patch` fills into a caller's report; a real store derives it from the stamps. */
  stamps: StampReport | null = null;
  /** What `driftedArtifacts` answers; a real store compares the disk against the stamps. */
  drift: DriftedArtifact[] = [];

  async driftedArtifacts(id?: string): Promise<DriftedArtifact[]> {
    this.record('driftedArtifacts', [id]);
    return this.drift;
  }

  async patch(patch: StateDict, id?: string, report?: PatchReport): Promise<StoredTask> {
    this.record('patch', [patch, id]);
    if (this.errors.patch !== undefined) throw this.errors.patch;
    const task = this.resolve(id, 'no active task');
    // `parent` addresses the tree rather than Σ, so it never reaches the merge. The fake applies
    // the move without re-checking it — the refusals belong to the store and are tested there.
    const statePatch: StateDict = { ...patch };
    const movesTree = 'parent' in statePatch;
    const requested = statePatch['parent'];
    delete statePatch['parent'];
    // Path keys ("plan[1].status") are expanded before anything else runs, as in the store.
    const expanded = expandPathPatch(task.state, statePatch);
    if (!expanded.ok) throw new FakePatchError('path', expanded.message);
    task.state = mergeState(task.state, expanded.patch);
    task.meta.updatedAt = '2026-09-05T10:05:00.000Z';
    if (movesTree) {
      const from = task.meta.parent;
      const to = typeof requested === 'string' && requested.trim() !== '' ? requested.trim() : null;
      task.meta.parent = to;
      if (report !== undefined && from !== to) report.moved = { from, to };
    }
    this.entries.push({ at: task.meta.updatedAt, patch: { ...patch }, ok: true });
    if (report !== undefined && this.stamps !== null) report.stamps = this.stamps;
    return task;
  }

  async finish(summary: string, id?: string): Promise<StoredTask> {
    this.record('finish', [summary, id]);
    if (this.errors.finish !== undefined) throw this.errors.finish;
    const task = this.resolve(id, 'no active task');
    const current = task.state['decisions'];
    const decisions: StateValue[] = Array.isArray(current) ? [...current, summary] : [summary];
    task.state = {
      ...task.state,
      status: 'done',
      decisions,
      next: { action: 'None — task finished', risk: 'safe' },
    };
    return task;
  }

  async list(): Promise<TaskSummary[]> {
    this.record('list', []);
    if (this.errors.list !== undefined) throw this.errors.list;
    const summaries = this.tasks.map((task) => {
      const plan = Array.isArray(task.state['plan']) ? (task.state['plan'] as Dict[]) : [];
      return {
        id: task.meta.id,
        goal: String(task.state['goal'] ?? ''),
        status: String(task.state['status'] ?? 'active'),
        skill: task.meta.skill,
        updatedAt: task.meta.updatedAt,
        createdAt: task.meta.createdAt,
        seq: this.tasks.indexOf(task),
        progressDone: plan.filter((item) => item['status'] === 'done').length,
        progressTotal: plan.length,
        parent: task.meta.parent,
      };
    });
    // The same rollup the real store does from its rows, so a tree reads the same from a fake.
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
    this.record('history', [id, limit]);
    if (this.errors.history !== undefined) throw this.errors.history;
    if (id === undefined) this.resolve(undefined, 'no active task');
    const newest = [...this.entries].reverse();
    return limit === undefined ? newest : newest.slice(0, limit);
  }

  async activeId(): Promise<string | null> {
    this.record('activeId', []);
    const open = [...this.tasks].reverse().find((task) => task.state['status'] === 'active');
    return open?.meta.id ?? null;
  }

  instructionsFor(task: StoredTask): string {
    this.record('instructionsFor', [task.meta.id]);
    return this.instructions;
  }
}

/** Identity function that forces the structural check against the port. */
const asPort = (store: FakeTaskStore): TaskStorePort => store;

function makeTools(resolver: ReturnType<typeof singleStoreResolver>) {
  const tools = createTaskTools(resolver);
  const tool = (name: string): TaskToolDefinition => {
    const found = tools.find((candidate) => candidate.name === name);
    if (found === undefined) throw new Error(`tool not registered: ${name}`);
    return found;
  };
  const call = (name: string, args: Dict = {}): Promise<ToolResult> => tool(name).handler(args);
  return { tools, tool, call };
}

function setup(errors: FakeErrors = {}, options: FakeStoreOptions = {}) {
  const store = new FakeTaskStore(options);
  store.errors = errors;
  return { store, ...makeTools(singleStoreResolver(asPort(store))) };
}

/** Two declared roots: the primary one plus a named project the tools may address. */
function setupProjects() {
  const primary = new FakeTaskStore({ rootDir: '/fake/primary/.state3' });
  const worker = new FakeTaskStore({ rootDir: '/fake/worker/.state3' });
  const projects: ProjectEntry[] = [{ name: 'worker', rootDir: '/fake/worker/.state3' }];
  const opened: string[] = [];
  const resolver = createProjectResolver(asPort(primary), projects, (rootDir) => {
    opened.push(rootDir);
    return asPort(worker);
  });
  return { primary, worker, opened, ...makeTools(resolver) };
}

/** The Σ JSON line: the one right after the `Task <id> [<skill>] (<status>):` header. */
function jsonLine(content: string): string {
  const lines = content.split('\n');
  const header = lines.findIndex((line) => /^Task \S+ \[\S+\] \(\w+\):$/.test(line));
  return header === -1 ? '' : (lines[header + 1] ?? '');
}

describe('createTaskTools', () => {
  it('registers exactly the six task tools', () => {
    const { tools } = setup();
    expect(tools.map((tool) => tool.name)).toEqual([
      'task_start',
      'task_show',
      'task_patch',
      'task_finish',
      'task_list',
      'task_history',
    ]);
  });

  it('gives every tool a description and an object input schema', () => {
    const { tools } = setup();
    for (const tool of tools) {
      expect(tool.description.trim().length).toBeGreaterThan(0);
      expect(tool.inputSchema['type']).toBe('object');
      expect(tool.inputSchema['additionalProperties']).toBe(false);
      expect(Array.isArray(tool.inputSchema['required'])).toBe(true);
      expect(typeof tool.inputSchema['properties']).toBe('object');
    }
  });

  it('declares required arguments in the schema of state-changing tools', () => {
    const { tool } = setup();
    expect(tool('task_start').inputSchema['required']).toEqual(['goal']);
    expect(tool('task_patch').inputSchema['required']).toEqual(['patch']);
    expect(tool('task_finish').inputSchema['required']).toEqual(['summary']);
  });

  it('declares the project argument on every tool, and skill and notation on task_start', () => {
    const { tools, tool } = setup();
    for (const definition of tools) {
      const properties = definition.inputSchema['properties'] as Dict;
      expect(properties['project']).toBeDefined();
    }
    const start = tool('task_start').inputSchema['properties'] as Dict;
    expect(start['skill']).toBeDefined();
    expect(start['notation']).toMatchObject({ enum: NOTATIONS });
  });
});

describe('task_start', () => {
  it('creates a task with goal and plan and returns its id and state', async () => {
    const { store, call } = setup();
    const result = await call('task_start', { goal: 'ship the MCP server', plan: ['a', 'b'] });
    expect(result.ok).toBe(true);
    expect(result.isError).toBeUndefined();
    expect(store.calledWith('start')).toEqual(['ship the MCP server', { plan: ['a', 'b'] }]);
    expect(result.content).toContain('Started task task-1 [dev-task] at .state3/task-1.json.');
    expect(result.content).toContain('Task task-1 [dev-task] (active):');
    expect(result.content).toContain('"goal":"ship the MCP server"');
  });

  it('reminds the agent to keep the state updated', async () => {
    const { call } = setup();
    const result = await call('task_start', { goal: 'ship it' });
    expect(result.ok).toBe(true);
    expect(result.content).toContain('task_patch');
    expect(result.content).toContain('task_show');
    expect(result.content).not.toContain('## How to keep this state (P)');
  });

  it('starts a task without a plan', async () => {
    const { store, call } = setup();
    const result = await call('task_start', { goal: 'ship it' });
    expect(result.ok).toBe(true);
    expect(store.calledWith('start')).toEqual(['ship it', {}]);
  });

  it('forwards the parent and says the subtask is queued rather than in flight', async () => {
    const { store, call } = setup();
    const result = await call('task_start', { goal: 'first piece', parent: 'task-0' });

    expect(result.ok).toBe(true);
    expect(store.calledWith('start')).toEqual(['first piece', { parent: 'task-0' }]);
    expect(result.content).toContain('Queued as a subtask of task-0');
    // Patching Σ after every step is advice for the work in flight, not for the queue behind it.
    expect(result.content).not.toContain('Keep this state current');
  });

  it('forwards the skill and gives the task its own Σ and header', async () => {
    const { store, call } = setup();
    const result = await call('task_start', { goal: 'review the worker', skill: 'supervise-task' });
    expect(result.ok).toBe(true);
    expect(store.calledWith('start')).toEqual(['review the worker', { skill: 'supervise-task' }]);
    expect(result.content).toContain(
      'Started task task-1 [supervise-task] at .state3/task-1.json.',
    );
    expect(result.content).toContain('Task task-1 [supervise-task] (active):');
    expect(jsonLine(result.content)).toContain('"rounds":[]');
    expect(jsonLine(result.content)).not.toContain('"plan"');
  });

  it('forwards the notation and keeps it in the task meta', async () => {
    const { store, call } = setup();
    const result = await call('task_start', { goal: 'ship it', notation: 'compact' });
    expect(result.ok).toBe(true);
    expect(store.calledWith('start')).toEqual(['ship it', { notation: 'compact' }]);
    expect(store.tasks[0]?.meta.notation).toBe('compact');
  });

  it('rejects an unknown notation and lists the valid ones without touching the store', async () => {
    const { store, call } = setup();
    const result = await call('task_start', { goal: 'ship it', notation: 'haiku' });
    expect(result.ok).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content).toBe('argument notation must be one of: plain, compact');
    expect(store.callCount('start')).toBe(0);
  });

  it('reports an unknown skill from the store with the skill hint', async () => {
    const { store, call } = setup();
    const result = await call('task_start', { goal: 'ship it', skill: 'alien' });
    expect(result.ok).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Patch rejected (skill)');
    expect(result.content).toContain('unknown skill "alien" (available: dev-task, supervise-task)');
    expect(result.content).toContain('name a skill this runtime has');
    expect(store.tasks).toHaveLength(0);
  });

  it('rejects a missing goal without touching the store', async () => {
    const { store, call } = setup();
    const result = await call('task_start', {});
    expect(result.ok).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('missing required argument: goal');
    expect(store.callCount('start')).toBe(0);
  });

  it('rejects an empty goal', async () => {
    const { store, call } = setup();
    const result = await call('task_start', { goal: '   ' });
    expect(result.ok).toBe(false);
    expect(result.isError).toBe(true);
    expect(store.callCount('start')).toBe(0);
  });

  it('rejects a non-string goal', async () => {
    const { call } = setup();
    const result = await call('task_start', { goal: 42 });
    expect(result.ok).toBe(false);
    expect(result.content).toContain('goal');
  });

  it('rejects a plan that is not an array', async () => {
    const { store, call } = setup();
    const result = await call('task_start', { goal: 'ship it', plan: 'a,b' });
    expect(result.ok).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('plan');
    expect(store.callCount('start')).toBe(0);
  });

  it('rejects a plan containing non-strings', async () => {
    const { call } = setup();
    const result = await call('task_start', { goal: 'ship it', plan: ['a', 2] });
    expect(result.ok).toBe(false);
    expect(result.content).toContain('non-empty strings');
  });

  it('rejects a non-string skill', async () => {
    const { store, call } = setup();
    const result = await call('task_start', { goal: 'ship it', skill: 3 });
    expect(result.ok).toBe(false);
    expect(result.content).toContain('skill');
    expect(store.callCount('start')).toBe(0);
  });
});

describe('task_show', () => {
  it('renders the active task as compact JSON when no id is given', async () => {
    const { store, call } = setup();
    const task = await store.start('ship it', { plan: ['a'] });
    const result = await call('task_show', {});
    expect(result.ok).toBe(true);
    expect(store.calledWith('show')?.[0]).toBeUndefined();
    expect(result.content.startsWith('Task task-1 [dev-task] (active):\n')).toBe(true);
    expect(jsonLine(result.content)).toBe(JSON.stringify(task.state));
    expect(jsonLine(result.content)).not.toMatch(/":\s/);
    expect(jsonLine(result.content)).toContain('"status":"active"');
  });

  it('answers view tree with the decomposition, and with neither Σ nor the procedure', async () => {
    const { store, call } = setup();
    await store.start('ship the release');
    await store.start('first piece', { parent: 'task-1' });

    const result = await call('task_show', { id: 'task-1', view: 'tree' });

    expect(result.ok).toBe(true);
    expect(result.content).toContain('ship the release');
    expect(result.content).toContain('first piece');
    expect(result.content).toContain('(1 subtask, 1 open)');
    // The point of the view: it answers about the tree, so it costs no state and no procedure.
    expect(result.content).not.toContain('"goal":');
    expect(result.content).not.toContain('How to keep this state');
  });

  it('passes an explicit id to the store', async () => {
    const { store, call } = setup();
    await store.start('first');
    await store.start('second');
    const result = await call('task_show', { id: 'task-1' });
    expect(store.calledWith('show')).toEqual(['task-1']);
    expect(result.content).toContain('"goal":"first"');
  });

  it('appends the procedure P the store returns for that task', async () => {
    const { store, call } = setup();
    await store.start('ship it');
    const result = await call('task_show', {});
    expect(result.content).toContain('## How to keep this state (P)');
    expect(result.content).toContain(INSTRUCTIONS);
    expect(store.calledWith('instructionsFor')).toEqual(['task-1']);
  });

  it('omits the procedure block when the store has no P for the task', async () => {
    const { store, call } = setup();
    store.instructions = '   ';
    await store.start('ship it');
    const result = await call('task_show', {});
    expect(result.ok).toBe(true);
    expect(result.content).not.toContain('## How to keep this state (P)');
    expect(result.content.startsWith('Task task-1 [dev-task] (active):')).toBe(true);
  });

  it('names the build that answered, so a resumed session can tell a stale runtime', async () => {
    const { store, call } = setup();
    await store.start('ship it');
    const result = await call('task_show', {});
    expect(result.ok).toBe(true);
    expect(result.content).toMatch(/runtime: state3 \S+ \(/);
  });

  it('leaves the runtime line out of the size view, which answers about Σ alone', async () => {
    const { store, call } = setup();
    await store.start('ship it');
    const result = await call('task_show', { view: 'size' });
    expect(result.ok).toBe(true);
    expect(result.content).not.toContain('runtime: state3');
  });

  it('names the artifacts the disk disagrees with, under the Σ that describes them', async () => {
    const { store, call } = setup();
    await store.start('ship it');
    store.drift = [
      {
        key: 'scenes/Car.tscn',
        recordedAt: '2026-09-19T21:40:00.000Z',
        modifiedAt: '2026-09-19T23:43:12.000Z',
        minutesAfter: 123,
      },
    ];

    const result = await call('task_show', {});

    expect(result.ok).toBe(true);
    expect(result.content).toContain('Artifacts changed on disk since Σ was last written');
    expect(result.content).toContain('scenes/Car.tscn (modified 2026-09-19T23:43:12Z, 123 min');
    expect(store.calledWith('driftedArtifacts')).toEqual(['task-1']);
  });

  it('leaves the answer without a drift line while the tree matches Σ', async () => {
    const { store, call } = setup();
    await store.start('ship it');

    const result = await call('task_show', {});

    expect(result.ok).toBe(true);
    expect(result.content).not.toContain('Artifacts changed on disk');
  });

  it('fails without throwing when there is no active task', async () => {
    const { call } = setup();
    const result = await call('task_show', {});
    expect(result.ok).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('no active task');
    expect(result.content).toContain('task_start');
    expect(result.content).toContain('(state root: /fake/project/.state3)');
  });

  it('fails for an unknown id', async () => {
    const { call } = setup();
    const result = await call('task_show', { id: 'nope' });
    expect(result.ok).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('task not found: nope');
  });

  it('rejects a non-string id', async () => {
    const { call } = setup();
    const result = await call('task_show', { id: 7 });
    expect(result.ok).toBe(false);
    expect(result.content).toContain('id');
  });

  it('answers the size of each field instead of Σ when asked for the size view', async () => {
    const { store, call } = setup();
    await store.start('ship it', { plan: ['a', 'b'] });

    const result = await call('task_show', { view: 'size' });

    expect(result.ok).toBe(true);
    expect(result.content).toContain('field(s), largest first');
    expect(result.content).toContain('- plan');
    // The report measures Σ and P; carrying either would cost what the call saves.
    expect(result.content).not.toContain('"goal":"ship it"');
    expect(result.content).not.toContain('## How to keep this state (P)');
    expect(result.content).toContain('task_show {"view":"state"}');
  });

  it('rejects a view it does not have', async () => {
    const { call } = setup();
    const result = await call('task_show', { view: 'brief' });
    expect(result.ok).toBe(false);
    expect(result.content).toContain('view must be one of: state, size');
  });

  it('normalizes a non-object argument payload instead of throwing', async () => {
    const { tool } = setup();
    const result = await tool('task_show').handler(null as unknown as Dict);
    expect(result.ok).toBe(false);
    expect(result.isError).toBe(true);
  });
});

describe('task_patch', () => {
  it('applies a valid patch and returns the updated state', async () => {
    const { store, call } = setup();
    await store.start('ship it', { plan: ['a'] });
    const result = await call('task_patch', {
      patch: { status: 'blocked', blockers: ['needs key'] },
    });
    expect(result.ok).toBe(true);
    expect(store.calledWith('patch')?.[0]).toEqual({ status: 'blocked', blockers: ['needs key'] });
    expect(result.content).toContain('Patched task task-1.');
    expect(jsonLine(result.content)).toContain('"status":"blocked"');
  });

  it('routes an explicit id to the store', async () => {
    const { store, call } = setup();
    await store.start('ship it');
    await call('task_patch', { patch: { decisions: ['used stdio'] }, id: 'task-1' });
    expect(store.calledWith('patch')).toEqual([{ decisions: ['used stdio'] }, 'task-1']);
  });

  it('returns Σ alone, without asking the store for P', async () => {
    const { store, call } = setup();
    await store.start('ship it');
    const result = await call('task_patch', { patch: { decisions: ['used stdio'] } });
    expect(result.ok).toBe(true);
    expect(result.content).not.toContain('## How to keep this state (P)');
    expect(store.callCount('instructionsFor')).toBe(0);
  });

  it('notes an artifact path that is not in the project, without refusing the patch', async () => {
    const { store, call } = setup();
    await store.start('ship it');

    const result = await call('task_patch', {
      patch: { artifacts: { 'src/reader.ts': 'the reader', 'src/writer.ts': 'the writer' } },
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain('Patched task task-1.');
    expect(result.content).toContain('not found in the project');
    expect(result.content).toContain('"src/writer.ts"');
  });

  it('says nothing about artifacts on a patch that does not touch them', async () => {
    const { store, call } = setup();
    await store.start('ship it');
    await call('task_patch', { patch: { artifacts: { 'src/absent.ts': 'x' } } });

    const result = await call('task_patch', { patch: { goal: 'renamed' } });

    expect(result.ok).toBe(true);
    expect(result.content).not.toContain('not found in the project');
  });

  it('names the verification stamps the patch detached, which Σ itself cannot show', async () => {
    const { store, call } = setup();
    await store.start('ship it');
    store.stamps = {
      carried: 1,
      stamped: 1,
      superseded: [
        {
          check: 'dev.bat check -> ALL CHECKS PASSED',
          at: '2026-09-19T21:54:18.959Z',
          commit: 'ea6f494',
        },
      ],
    };

    const result = await call('task_patch', { patch: { decisions: ['compressed Σ'] } });

    expect(result.ok).toBe(true);
    expect(result.content).toContain('1 verification stamp(s) are no longer attached');
    expect(result.content).toContain(
      '"dev.bat check -> ALL CHECKS PASSED" was at 2026-09-19T21:54:18.959Z commit ea6f494',
    );
  });

  it('says nothing about stamps when the patch detached none', async () => {
    const { store, call } = setup();
    await store.start('ship it');
    store.stamps = { carried: 2, stamped: 1, superseded: [] };

    const result = await call('task_patch', { patch: { decisions: ['one more'] } });

    expect(result.ok).toBe(true);
    expect(result.content).not.toContain('no longer attached');
  });

  it('names both ends of a move in the tree, which Σ cannot show', async () => {
    const { store, call } = setup();
    await store.start('the decomposition');
    await store.start('a piece of it', { parent: 'task-1' });
    await store.start('somewhere else');

    const result = await call('task_patch', { patch: { parent: 'task-3' }, id: 'task-2' });

    expect(result.ok).toBe(true);
    expect(result.content).toContain('Moved from task-1 under task-3');
    // The rendered Σ reads the same either way — the parent is a column — so without that line
    // the answer would not say the task is anywhere else than it was.
    expect(jsonLine(result.content)).not.toContain('task-3');
  });

  it('names a task detached into a root, and one filed under its first decomposition', async () => {
    const { store, call } = setup();
    await store.start('the decomposition');
    await store.start('a piece of it', { parent: 'task-1' });

    const detached = await call('task_patch', { patch: { parent: null }, id: 'task-2' });
    expect(detached.content).toContain('Moved out of task-1 into a root task');

    const filed = await call('task_patch', { patch: { parent: 'task-1' }, id: 'task-2' });
    expect(filed.content).toContain('Filed under task-1 as a subtask');
  });

  it('says nothing about the tree when the patch moved nothing', async () => {
    const { store, call } = setup();
    await store.start('ship it');

    const result = await call('task_patch', { patch: { decisions: ['one more'] } });

    expect(result.ok).toBe(true);
    expect(result.content).not.toContain('Moved');
    expect(result.content).not.toContain('Filed under');
  });

  it('applies a path key that changes one plan item', async () => {
    const { store, call } = setup();
    await store.start('ship it', { plan: ['a', 'b'] });
    const result = await call('task_patch', { patch: { 'plan[1].status': 'in_progress' } });
    expect(result.ok).toBe(true);
    expect(store.calledWith('patch')?.[0]).toEqual({ 'plan[1].status': 'in_progress' });
    const line = jsonLine(result.content);
    expect(line).toContain('"task":"b","status":"in_progress"');
    expect(line).toContain('"task":"a","status":"pending"');
  });

  it('appends a plan item with a [+] path key', async () => {
    const { store, call } = setup();
    await store.start('ship it', { plan: ['a'] });
    const result = await call('task_patch', {
      patch: { 'plan[+]': { id: '2', task: 'b', status: 'pending', notes: '' } },
    });
    expect(result.ok).toBe(true);
    const plan = store.tasks[0]?.state['plan'] as Dict[];
    expect(plan.map((item) => item['task'])).toEqual(['a', 'b']);
  });

  it('reports a bad path key with the path category and its hint', async () => {
    const { store, call } = setup();
    await store.start('ship it', { plan: ['a'] });
    const result = await call('task_patch', { patch: { 'plan[7].status': 'done' } });
    expect(result.ok).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Patch rejected (path)');
    expect(result.content).toContain('out of range');
    expect(result.content).toContain('check the path key');
    expect(result.content).toContain('state was not modified');
    expect((store.tasks[0]?.state['plan'] as Dict[])[0]).toMatchObject({ status: 'pending' });
  });

  it('rejects a path into a field that is not an array', async () => {
    const { call } = setup();
    await call('task_start', { goal: 'ship it' });
    const result = await call('task_patch', { patch: { 'goal[0]': 'x' } });
    expect(result.ok).toBe(false);
    expect(result.content).toContain('(path)');
    expect(result.content).toContain('needs an array field "goal"');
  });

  it('rejects a missing patch', async () => {
    const { store, call } = setup();
    const result = await call('task_patch', {});
    expect(result.ok).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('missing required argument: patch');
    expect(store.callCount('patch')).toBe(0);
  });

  it('rejects a patch that is an array', async () => {
    const { call } = setup();
    const result = await call('task_patch', { patch: ['status'] });
    expect(result.ok).toBe(false);
    expect(result.content).toContain('JSON object');
  });

  it('rejects a null patch', async () => {
    const { call } = setup();
    const result = await call('task_patch', { patch: null });
    expect(result.ok).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not null');
  });

  it('rejects a patch that is not an object at all', async () => {
    const { call } = setup();
    const result = await call('task_patch', { patch: 'status=done' });
    expect(result.ok).toBe(false);
    expect(result.content).toContain('JSON object');
  });

  it('reports a guard rejection with category, message and state untouched', async () => {
    const { store, call } = setup({
      patch: new FakePatchError('guard', 'a done plan item cannot go back to pending'),
    });
    await store.start('ship it', { plan: ['a'] });
    const result = await call('task_patch', { patch: { plan: [] } });
    expect(result.ok).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('guard');
    expect(result.content).toContain('a done plan item cannot go back to pending');
    expect(result.content).toContain('state was not modified');
    expect(store.tasks[0]?.state['status']).toBe('active');
  });

  it('hints how to fix an unknown-key rejection', async () => {
    const { call } = setup({
      patch: new FakePatchError('unknown-key', 'Unrecognized key "bogus"'),
    });
    const result = await call('task_patch', { patch: { bogus: 1 } });
    expect(result.ok).toBe(false);
    expect(result.content).toContain('unknown-key');
    expect(result.content).toContain('remove keys not present in the schema');
  });

  it('hints how to fix a type-coercion and a schema rejection', async () => {
    const coercion = await setup({
      patch: new FakePatchError('type-coercion', 'Expected number, received string at "limit"'),
    }).call('task_patch', { patch: { limit: 'five' } });
    expect(coercion.content).toContain('check value types against the schema');

    const schema = await setup({
      patch: new FakePatchError('schema', 'State validation failed at "goal"'),
    }).call('task_patch', { patch: { goal: '' } });
    expect(schema.content).toContain('the merged state would not satisfy the schema');
  });

  it('gives every published rejection category its own hint', async () => {
    const fallback = 're-read the current state with task_show';
    for (const category of REJECT_CATEGORIES) {
      const { call } = setup({ patch: new FakePatchError(category, 'boom') });
      const result = await call('task_patch', { patch: {} });
      expect(result.content, category).toContain(`Patch rejected (${category})`);
      expect(result.content, category).toContain('Hint: ');
      expect(result.content, category).not.toContain(fallback);
    }
  });

  it('falls back to a generic hint for a category outside the vocabulary', async () => {
    const { call } = setup({ patch: new FakePatchError('quantum-flux', 'boom') });
    const result = await call('task_patch', { patch: {} });
    expect(result.content).toContain('Patch rejected (quantum-flux)');
    expect(result.content).toContain('re-read the current state with task_show');
  });

  it('handles a not-found error without throwing', async () => {
    const { call } = setup({ patch: new FakeNotFoundError('task not found: gone') });
    const result = await call('task_patch', { patch: { status: 'done' }, id: 'gone' });
    expect(result.ok).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('task not found: gone');
    expect(result.content).toContain('task_start');
  });

  it('handles an arbitrary store error', async () => {
    const { call } = setup({ patch: new Error('EACCES: permission denied') });
    const result = await call('task_patch', { patch: { status: 'done' } });
    expect(result.ok).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('EACCES: permission denied');
  });

  it('handles a non-Error rejection value', async () => {
    const { call } = setup({ patch: 'boom' });
    const result = await call('task_patch', { patch: { status: 'done' } });
    expect(result.ok).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('boom');
  });
});

describe('task_finish', () => {
  it('finishes the active task with a summary', async () => {
    const { store, call } = setup();
    await store.start('ship it');
    const result = await call('task_finish', { summary: 'server shipped and tested' });
    expect(result.ok).toBe(true);
    expect(store.calledWith('finish')?.[0]).toBe('server shipped and tested');
    expect(result.content).toContain('Finished task task-1.');
    expect(result.content).toContain('Task task-1 [dev-task] (done):');
    expect(jsonLine(result.content)).toContain('"status":"done"');
    expect(jsonLine(result.content)).toContain('server shipped and tested');
    expect(store.callCount('instructionsFor')).toBe(0);
  });

  it('rejects a missing summary', async () => {
    const { store, call } = setup();
    const result = await call('task_finish', {});
    expect(result.ok).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('missing required argument: summary');
    expect(store.callCount('finish')).toBe(0);
  });

  it('reports a not-found error instead of throwing', async () => {
    const { call } = setup({ finish: new FakeNotFoundError('no active task') });
    const result = await call('task_finish', { summary: 'done' });
    expect(result.ok).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('no active task');
  });
});

describe('task_list', () => {
  it('lists tasks with id, skill, goal, status and progress', async () => {
    const { store, call } = setup();
    await store.start('first', { plan: ['a', 'b'] });
    await store.start('second');
    await store.patch(
      {
        plan: [
          { id: '1', task: 'a', status: 'done', notes: '' },
          { id: '2', task: 'b', status: 'pending', notes: '' },
        ],
      },
      'task-1',
    );
    const result = await call('task_list', {});
    expect(result.ok).toBe(true);
    expect(result.content).toContain('Tasks (2):');
    expect(result.content).toContain(
      '- task-1 [dev-task] (active) progress 1/2 updated 2026-09-05T10:05:00.000Z — first',
    );
    expect(result.content).toContain('task-2');
    expect(result.content).toContain('second');
  });

  it('prints the skill of every task, so a mixed root is readable', async () => {
    const { store, call } = setup();
    await store.start('implement the parser');
    await store.start('review the worker', { skill: 'supervise-task' });
    const result = await call('task_list', {});
    const lines = result.content.split('\n');
    expect(lines[1]).toContain('- task-1 [dev-task] (active) progress 0/0');
    expect(lines[2]).toContain('- task-2 [supervise-task] (active) progress 0/0');
  });

  it('appends the skills the store exposes as a capability line', async () => {
    const { call } = setup();
    const result = await call('task_list', {});
    expect(result.content).toContain('skills: dev-task, supervise-task');
  });

  it('names the build that answered, so a host serving stale code is visible', async () => {
    const { call } = setup();
    const result = await call('task_list', {});
    expect(result.content).toMatch(/runtime: state3 \S+ \(/);
  });

  it('omits the skills line when the store does not expose skillNames', async () => {
    const { call } = setup({}, { skills: null });
    const result = await call('task_list', {});
    expect(result.ok).toBe(true);
    expect(result.content).not.toContain('skills:');
  });

  it('appends the declared projects as a capability line', async () => {
    const { call } = setupProjects();
    const result = await call('task_list', {});
    expect(result.content).toContain('projects: worker (/fake/worker/.state3)');
    expect(result.content).toContain('skills: dev-task, supervise-task');
  });

  it('reports an empty store as ok with "no tasks"', async () => {
    const { call } = setup();
    const result = await call('task_list', {});
    expect(result.ok).toBe(true);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('no tasks');
  });

  it('names the state root in an empty list so a wrong host cwd is visible', async () => {
    const { call } = setup();
    const result = await call('task_list', {});
    expect(result.content).toContain('no tasks (state root: /fake/project/.state3)');
  });

  it('reports a store failure as an error result', async () => {
    const { call } = setup({ list: new Error('disk on fire') });
    const result = await call('task_list', {});
    expect(result.ok).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('disk on fire');
  });
});

describe('task_history', () => {
  it('defaults to the active task and shows accepted patches', async () => {
    const { store, call } = setup();
    await store.start('ship it', { plan: ['a'] });
    await store.patch({ decisions: ['used stdio'] });
    const result = await call('task_history', {});
    expect(result.ok).toBe(true);
    expect(store.calledWith('history')).toEqual([undefined, undefined]);
    expect(result.content).toContain('History (active task):');
    expect(result.content).toContain('ok');
    expect(result.content).toContain('decisions');
  });

  it('names the task when an explicit id is given', async () => {
    const { store, call } = setup();
    await store.start('ship it');
    await store.patch({ decisions: ['one'] });
    const result = await call('task_history', { id: 'task-1' });
    expect(store.calledWith('history')).toEqual(['task-1', undefined]);
    expect(result.content).toContain('History for task task-1:');
  });

  it('passes an explicit limit to the store', async () => {
    const { store, call } = setup();
    await store.start('ship it');
    await store.patch({ decisions: ['one'] });
    await store.patch({ decisions: ['two'] });
    await call('task_history', { id: 'task-1', limit: 1 });
    expect(store.calledWith('history')).toEqual(['task-1', 1]);
  });

  it('shows a path-key patch exactly as the caller sent it', async () => {
    const { store, call } = setup();
    await store.start('ship it', { plan: ['a', 'b'] });
    await store.patch({ 'plan[1].status': 'in_progress' });
    const result = await call('task_history', {});
    expect(result.ok).toBe(true);
    expect(result.content).toContain('patched: plan[1].status');
  });

  it('includes rejected patches with their category and message', async () => {
    const { store, call } = setup();
    await store.start('ship it');
    await store.patch({ decisions: ['one'] });
    store.entries.push({
      at: '2026-09-05T10:06:00.000Z',
      patch: { bogus: 1 },
      ok: false,
      error: { category: 'unknown-key', message: 'Unrecognized key "bogus"' },
    });
    const result = await call('task_history', {});
    expect(result.ok).toBe(true);
    expect(result.content).toContain('REJECTED (unknown-key)');
    expect(result.content).toContain('Unrecognized key "bogus"');
    expect(result.content).toContain('bogus');
  });

  it('keeps the note of an applied patch, so a superseded stamp stays auditable', async () => {
    const { store, call } = setup();
    await store.start('ship it');
    store.entries.push({
      at: '2026-09-05T10:08:00.000Z',
      patch: { verifications: [{ check: 'dev.bat check PASSED', status: 'pass' }] },
      ok: true,
      note:
        '1 verification stamp(s) superseded: "dev.bat check -> ALL PASSED" was at ' +
        '2026-09-19T21:54:18.959Z commit ea6f494',
    });

    const result = await call('task_history', {});

    expect(result.ok).toBe(true);
    expect(result.content).toContain('ok — patched: verifications — 1 verification stamp(s)');
    expect(result.content).toContain('commit ea6f494');
  });

  it('reports an entry without a category as invalid', async () => {
    const { store, call } = setup();
    await store.start('ship it');
    store.entries.push({ at: '2026-09-05T10:07:00.000Z', patch: {}, ok: false });
    const result = await call('task_history', {});
    expect(result.content).toContain('REJECTED (invalid)');
    expect(result.content).toContain('empty patch');
  });

  it('reports an empty history without failing', async () => {
    const { store, call } = setup();
    await store.start('ship it');
    const result = await call('task_history', {});
    expect(result.ok).toBe(true);
    expect(result.content).toContain('no history entries');
  });

  it('rejects a non-numeric limit before calling the store', async () => {
    const { store, call } = setup();
    await store.start('ship it');
    const result = await call('task_history', { limit: 'five' });
    expect(result.ok).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('limit');
    expect(result.content).not.toContain('NaN');
    expect(store.callCount('history')).toBe(0);
  });

  it('rejects a non-positive or fractional limit', async () => {
    const { store, call } = setup();
    await store.start('ship it');
    for (const limit of [0, -3, 1.5]) {
      const result = await call('task_history', { limit });
      expect(result.ok).toBe(false);
      expect(result.content).toContain('integer >= 1');
    }
    expect(store.callCount('history')).toBe(0);
  });

  it('rejects a non-string id', async () => {
    const { store, call } = setup();
    const result = await call('task_history', { id: 7 });
    expect(result.ok).toBe(false);
    expect(result.content).toContain('id');
    expect(store.callCount('history')).toBe(0);
  });

  it('reports a store failure as an error result', async () => {
    const { call } = setup({ history: new FakeNotFoundError('no active task') });
    const result = await call('task_history', {});
    expect(result.ok).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('no active task');
    expect(result.content).toContain('task_start');
  });
});

describe('the project argument', () => {
  it('routes a call to the store of the named project', async () => {
    const { primary, worker, opened, call } = setupProjects();
    const result = await call('task_start', { goal: 'follow the worker', project: 'worker' });
    expect(result.ok).toBe(true);
    expect(opened).toEqual(['/fake/worker/.state3']);
    expect(worker.tasks).toHaveLength(1);
    expect(primary.tasks).toHaveLength(0);
    expect(primary.callCount('start')).toBe(0);
    expect(worker.calledWith('start')).toEqual(['follow the worker', {}]);
  });

  it('stays on the primary store when project is omitted', async () => {
    const { primary, worker, opened, call } = setupProjects();
    await call('task_start', { goal: 'own work' });
    expect(primary.tasks).toHaveLength(1);
    expect(worker.tasks).toHaveLength(0);
    expect(opened).toEqual([]);
  });

  it('routes every tool by project, so a supervisor can read a worker root', async () => {
    const { worker, call } = setupProjects();
    await call('task_start', { goal: 'worker task', project: 'worker' });
    await call('task_patch', { patch: { decisions: ['picked a'] }, project: 'worker' });

    const shown = await call('task_show', { project: 'worker' });
    expect(shown.ok).toBe(true);
    expect(shown.content).toContain('"goal":"worker task"');
    expect(worker.calledWith('show')).toEqual([undefined]);

    const history = await call('task_history', { project: 'worker' });
    expect(history.content).toContain('decisions');

    const finished = await call('task_finish', { summary: 'shipped', project: 'worker' });
    expect(finished.ok).toBe(true);
    expect(finished.content).toContain('Finished task task-1.');
  });

  it('rejects an unknown project and names the declared ones', async () => {
    const { primary, worker, call } = setupProjects();
    const result = await call('task_list', { project: 'nope' });
    expect(result.ok).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('unknown project "nope"');
    expect(result.content).toContain('worker (/fake/worker/.state3)');
    expect(primary.callCount('list')).toBe(0);
    expect(worker.callCount('list')).toBe(0);
  });

  it('rejects a non-string project before resolving anything', async () => {
    const { primary, call } = setupProjects();
    const result = await call('task_show', { project: 7 });
    expect(result.ok).toBe(false);
    expect(result.content).toContain('argument project must be a non-empty string when provided');
    expect(primary.callCount('show')).toBe(0);
  });

  it('names the state root of the addressed store in a not-found diagnostic', async () => {
    const { call } = setupProjects();
    const result = await call('task_show', { project: 'worker' });
    expect(result.ok).toBe(false);
    expect(result.content).toContain('(state root: /fake/worker/.state3)');
  });
});

describe('renderState', () => {
  it('renders one compact JSON line under a task header naming the skill', async () => {
    const { store } = setup();
    const task = await store.start('ship it', { plan: ['a'] });
    const rendered = renderState(task);
    const lines = rendered.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('Task task-1 [dev-task] (active):');
    expect(lines[1]).toBe(JSON.stringify(task.state));
    expect(lines[1]).not.toMatch(/^\s/);
    expect(rendered).not.toContain('## How to keep this state (P)');
  });

  it('renders a supervise task with its own Σ under its own header', async () => {
    const { store } = setup();
    const task = await store.start('review', { skill: 'supervise-task' });
    expect(renderState(task).split('\n')[0]).toBe('Task task-1 [supervise-task] (active):');
    expect(renderState(task)).toContain('"rounds":[]');
  });
});

describe('renderStateWithProcedure', () => {
  it('appends the procedure P the store returns for the task', async () => {
    const { store } = setup();
    const task = await store.start('ship it');
    const rendered = renderStateWithProcedure(asPort(store), task);
    expect(rendered.startsWith(renderState(task))).toBe(true);
    expect(rendered).toContain('\n\n## How to keep this state (P)\n');
    expect(rendered.endsWith(INSTRUCTIONS)).toBe(true);
  });

  it('omits the block when the store returns a blank P', async () => {
    const { store } = setup();
    const task = await store.start('ship it');
    store.instructions = '   ';
    expect(renderStateWithProcedure(asPort(store), task)).toBe(renderState(task));
    expect(renderStateWithProcedure(asPort(store), task)).not.toContain(
      '## How to keep this state (P)',
    );
  });

  it('returns whatever P the store has for that task, per task', async () => {
    const { store } = setup();
    store.instructions = 'supervise: review the worker yourself, never accept on its word.';
    const task = await store.start('review', { skill: 'supervise-task' });
    expect(renderStateWithProcedure(asPort(store), task)).toContain('never accept on its word.');
  });
});

describe('classifyError', () => {
  it('detects not-found errors by name', () => {
    expect(classifyError(new FakeNotFoundError('nope'))).toEqual({
      kind: 'not-found',
      message: 'nope',
    });
  });

  it('detects patch errors by their category field', () => {
    expect(classifyError(new FakePatchError('guard', 'not allowed'))).toEqual({
      kind: 'patch',
      category: 'guard',
      message: 'not allowed',
    });
  });

  it('classifies the new path and skill categories', () => {
    expect(classifyError(new FakePatchError('path', 'out of range'))).toEqual({
      kind: 'patch',
      category: 'path',
      message: 'out of range',
    });
    expect(classifyError(new FakePatchError('skill', 'unknown skill'))).toEqual({
      kind: 'patch',
      category: 'skill',
      message: 'unknown skill',
    });
  });

  it('falls back to the message for unknown errors', () => {
    expect(classifyError(new Error('EACCES'))).toEqual({ kind: 'patch', message: 'EACCES' });
    expect(classifyError('boom')).toEqual({ kind: 'patch', message: 'boom' });
  });
});
