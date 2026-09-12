import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createMcpServer,
  parseServerArgs,
  resolveProjectEntries,
  RUNTIME_INSTRUCTIONS,
} from '../../src/mcp/server.js';
import { createProjectResolver } from '../../src/tasks/projects.js';
import { TaskStore } from '../../src/tasks/store.js';

const STATE_DIR_VAR = 'SKILLSTATE_STATE_DIR';
const PROJECTS_VAR = 'SKILLSTATE_PROJECTS';

/** What `client.callTool` resolves to in this SDK version. */
type CallResult = Awaited<ReturnType<Client['callTool']>>;

const cwd = process.cwd();
let savedStateDir: string | undefined;
let savedProjects: string | undefined;

beforeEach(() => {
  savedStateDir = process.env[STATE_DIR_VAR];
  savedProjects = process.env[PROJECTS_VAR];
  delete process.env[STATE_DIR_VAR];
  delete process.env[PROJECTS_VAR];
});

afterEach(() => {
  if (savedStateDir === undefined) delete process.env[STATE_DIR_VAR];
  else process.env[STATE_DIR_VAR] = savedStateDir;
  if (savedProjects === undefined) delete process.env[PROJECTS_VAR];
  else process.env[PROJECTS_VAR] = savedProjects;
});

describe('parseServerArgs', () => {
  it('defaults to .skillstate in the current directory', () => {
    expect(parseServerArgs([])).toEqual({
      root: resolve('.skillstate'),
      projects: [],
      help: false,
    });
  });

  it('takes the state directory from the environment when the host starts us outside the project', () => {
    process.env[STATE_DIR_VAR] = 'D:/somewhere/else/.skillstate';
    expect(parseServerArgs([]).root).toBe(resolve('D:/somewhere/else/.skillstate'));
  });

  it('ignores a blank environment override', () => {
    process.env[STATE_DIR_VAR] = '   ';
    expect(parseServerArgs([]).root).toBe(resolve('.skillstate'));
  });

  it('lets --root win over the environment', () => {
    process.env[STATE_DIR_VAR] = 'D:/from-env';
    expect(parseServerArgs(['--root', 'D:/from-flag']).root).toBe(resolve('D:/from-flag'));
  });

  it('reports the help flag', () => {
    expect(parseServerArgs(['--help']).help).toBe(true);
    expect(parseServerArgs(['-h']).help).toBe(true);
  });

  it('rejects an unknown argument and a missing --root value', () => {
    expect(() => parseServerArgs(['--nope'])).toThrow(/Unknown argument/);
    expect(() => parseServerArgs(['--root'])).toThrow(/Missing value/);
  });

  it('collects --project declarations raw and in order, leaving them unresolved', () => {
    expect(parseServerArgs(['--project', 'worker=state/worker'])).toEqual({
      root: resolve('.skillstate'),
      projects: ['worker=state/worker'],
      help: false,
    });
    expect(
      parseServerArgs([
        '--project',
        'worker=state/worker',
        '--project',
        'review=state/review',
        '--project',
        'third=state/third',
      ]).projects,
    ).toEqual(['worker=state/worker', 'review=state/review', 'third=state/third']);
  });

  it('rejects a missing --project value', () => {
    expect(() => parseServerArgs(['--project'])).toThrow(/Missing value for --project/);
    expect(() => parseServerArgs(['--root', 'state', '--project'])).toThrow(
      /Missing value for --project/,
    );
  });

  it('combines --root, repeated --project and --help', () => {
    const options = parseServerArgs([
      '--root',
      'build/state',
      '--project',
      'worker=state/worker',
      '--help',
    ]);
    expect(options).toEqual({
      root: resolve('build/state'),
      projects: ['worker=state/worker'],
      help: true,
    });
  });

  it('reads no projects from the environment: parseServerArgs only collects flags', () => {
    process.env[PROJECTS_VAR] = 'worker=state/worker';
    expect(parseServerArgs([]).projects).toEqual([]);
  });
});

describe('resolveProjectEntries', () => {
  it('returns no entries when nothing is declared', () => {
    expect(resolveProjectEntries([], cwd)).toEqual([]);
  });

  it('parses semicolon-separated name=dir declarations from the environment', () => {
    process.env[PROJECTS_VAR] = 'worker=state/worker;review=state/review';
    expect(resolveProjectEntries([], cwd)).toEqual([
      { name: 'worker', rootDir: resolve(cwd, 'state/worker') },
      { name: 'review', rootDir: resolve(cwd, 'state/review') },
    ]);
  });

  it('parses newline-separated declarations from the environment', () => {
    process.env[PROJECTS_VAR] = 'worker=state/worker\nreview=state/review\n';
    expect(resolveProjectEntries([], cwd).map((entry) => entry.name)).toEqual(['worker', 'review']);
  });

  it('parses a JSON object from the environment', () => {
    process.env[PROJECTS_VAR] = JSON.stringify({
      worker: 'state/worker',
      review: resolve(cwd, 'state/review'),
    });
    expect(resolveProjectEntries([], cwd)).toEqual([
      { name: 'worker', rootDir: resolve(cwd, 'state/worker') },
      { name: 'review', rootDir: resolve(cwd, 'state/review') },
    ]);
  });

  it('resolves relative directories against the given cwd, not the process cwd', () => {
    const host = resolve(cwd, 'host-startup-dir');
    expect(resolveProjectEntries(['worker=state/worker'], host)).toEqual([
      { name: 'worker', rootDir: resolve(host, 'state/worker') },
    ]);
  });

  it('merges environment declarations first, then command-line ones', () => {
    process.env[PROJECTS_VAR] = 'from-env=state/env';
    expect(resolveProjectEntries(['from-flag=state/flag'], cwd).map((entry) => entry.name)).toEqual(
      ['from-env', 'from-flag'],
    );
  });

  it('accepts several declarations in one --project value', () => {
    expect(
      resolveProjectEntries(['worker=state/worker;review=state/review'], cwd).map(
        (entry) => entry.name,
      ),
    ).toEqual(['worker', 'review']);
  });

  it('throws when the same name is declared twice across env and flags', () => {
    process.env[PROJECTS_VAR] = 'worker=state/env-worker';
    expect(() => resolveProjectEntries(['worker=state/flag-worker'], cwd)).toThrow(
      /project "worker" is declared twice/,
    );
  });

  it('throws when the same name is declared twice on the command line', () => {
    expect(() => resolveProjectEntries(['worker=state/a', 'worker=state/b'], cwd)).toThrow(
      /project "worker" is declared twice/,
    );
  });

  it('throws when the same name is declared twice inside the environment', () => {
    process.env[PROJECTS_VAR] = 'worker=state/a;worker=state/b';
    expect(() => resolveProjectEntries([], cwd)).toThrow(/project "worker" is declared twice/);
  });

  it('propagates a bad declaration from the environment', () => {
    process.env[PROJECTS_VAR] = 'Worker=state/worker';
    expect(() => resolveProjectEntries([], cwd)).toThrow(/invalid project name "Worker"/);

    process.env[PROJECTS_VAR] = 'state/worker';
    expect(() => resolveProjectEntries([], cwd)).toThrow(/must look like name=directory/);

    process.env[PROJECTS_VAR] = '{ not json';
    expect(() => resolveProjectEntries([], cwd)).toThrow(/does not parse/);
  });

  it('propagates a bad declaration from the command line', () => {
    expect(() => resolveProjectEntries(['worker='], cwd)).toThrow(/empty directory/);
  });
});

describe('createMcpServer over an in-memory transport', () => {
  let primaryRoot: string;
  let workerRoot: string;
  let client: Client;
  /** Every store the server was given, so afterEach can release the database handles. */
  let stores: TaskStore[];

  /** Text of the content blocks of a tool result. */
  function textOf(result: CallResult): string {
    const blocks = result.content as unknown as Array<{ type?: string; text?: string }>;
    return blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n');
  }

  function tracked(rootDir: string): TaskStore {
    const store = new TaskStore(rootDir);
    stores.push(store);
    return store;
  }

  async function connect(instructions?: string): Promise<void> {
    const store = tracked(primaryRoot);
    const resolver = createProjectResolver(
      store,
      [{ name: 'worker', rootDir: workerRoot }],
      (rootDir) => tracked(rootDir),
    );
    const server =
      instructions === undefined
        ? createMcpServer(resolver)
        : createMcpServer(resolver, instructions);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  }

  beforeEach(async () => {
    stores = [];
    primaryRoot = await mkdtemp(resolve(tmpdir(), 'skillstate-primary-'));
    workerRoot = await mkdtemp(resolve(tmpdir(), 'skillstate-worker-'));
  });

  afterEach(async () => {
    await client?.close();
    // Windows will not delete a directory whose database handle is still open, and
    // closing folds the WAL back so the root is left with the one file.
    for (const store of stores) store.close();
    await rm(primaryRoot, { recursive: true, force: true });
    await rm(workerRoot, { recursive: true, force: true });
  });

  it('publishes the six task tools, each addressable by project', async () => {
    await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'task_start',
      'task_show',
      'task_patch',
      'task_finish',
      'task_list',
      'task_history',
    ]);
    for (const tool of tools) {
      const properties = tool.inputSchema.properties as Record<string, unknown>;
      expect(properties['project']).toBeDefined();
    }
    const start = tools[0]?.inputSchema.properties as Record<string, unknown>;
    expect(start['skill']).toBeDefined();
    expect(start['notation']).toBeDefined();
  });

  it('sends the runtime instructions by default, and the override when given', async () => {
    await connect();
    expect(client.getInstructions()).toBe(RUNTIME_INSTRUCTIONS);
    expect(RUNTIME_INSTRUCTIONS).toContain('task_patch');
    await client.close();

    await connect('short connection-level instructions');
    expect(client.getInstructions()).toBe('short connection-level instructions');
  });

  it('starts a task in the primary root and lists it with its skill', async () => {
    await connect();
    const started = await client.callTool({
      name: 'task_start',
      arguments: { goal: 'ship the server', plan: ['wire tools'] },
    });
    expect(started.isError).toBe(false);
    expect(textOf(started)).toContain('[dev-task]');
    expect(textOf(started)).toContain(primaryRoot);

    const listed = await client.callTool({ name: 'task_list', arguments: {} });
    const text = textOf(listed);
    expect(text).toContain('ship the server');
    expect(text).toContain('skills: dev-task, supervise-task');
    expect(text).toContain(`projects: worker (${workerRoot})`);

    // One database for the whole root, not one file per task. The `-wal`/`-shm`
    // siblings exist only while a connection is open.
    const files = await readdir(primaryRoot);
    expect(files).toContain('state.db');
    expect(files.filter((file) => !file.startsWith('state.db'))).toEqual([]);
  });

  it('routes a call with a project argument to that declared root', async () => {
    await connect();
    const started = await client.callTool({
      name: 'task_start',
      arguments: { goal: 'worker task', project: 'worker', skill: 'supervise-task' },
    });
    expect(started.isError).toBe(false);
    expect(textOf(started)).toContain('[supervise-task]');
    expect(textOf(started)).toContain(workerRoot);
    const workerFiles = await readdir(workerRoot);
    expect(workerFiles).toContain('state.db');
    expect(workerFiles.filter((file) => !file.startsWith('state.db'))).toEqual([]);
    expect(await readdir(primaryRoot)).toHaveLength(0);

    const listed = await client.callTool({
      name: 'task_list',
      arguments: { project: 'worker' },
    });
    expect(textOf(listed)).toContain('worker task');
  });

  it('turns an unknown project into an error result naming the declared ones', async () => {
    await connect();
    const result = await client.callTool({ name: 'task_list', arguments: { project: 'nope' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('unknown project "nope"');
    expect(textOf(result)).toContain(`worker (${workerRoot})`);
  });

  it('reports an unknown tool as a protocol error', async () => {
    await connect();
    await expect(client.callTool({ name: 'task_nope', arguments: {} })).rejects.toThrow(
      /Unknown tool: task_nope/,
    );
  });
});
