import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, ListToolsResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ProjectEntry, StoreResolver, TaskStorePort } from '../tasks/ports.js';
import { parseProjectsSpec } from '../tasks/projects.js';
import type { TaskStore } from '../tasks/store.js';
import type { DatabaseOwner, KbResolver, KbStores } from '../kb/ports.js';
import { LinkStore } from '../kb/links.js';
import { PageStore } from '../kb/store.js';
import { createKbTools } from './kb-tools.js';
import { createTaskTools } from './tools.js';
import type { TaskToolDefinition } from './tools.js';

const SERVER_INFO = { name: 'state3', version: '0.2.0' };

/**
 * Connection-level instructions. Deliberately short: the procedure P of a task
 * belongs to that task's skill and notation, and `task_show` returns it with Σ.
 */
export const RUNTIME_INSTRUCTIONS: string = `state3 keeps the progress of long-horizon work in an external state Σ that is validated on every write, instead of in the conversation transcript, so it survives compaction and restarts.

Tools: task_start, task_show, task_patch, task_finish, task_list, task_history, project_brief, page, search.
Each task names a skill, and the skill owns the Σ schema, the domain rules and the procedure P — "dev-task" implements work in a project, "supervise-task" reviews work another agent does. Call task_show to read Σ together with the P of that task, call task_patch after every meaningful step with only the fields that changed, and call task_list to see the skills and projects this runtime knows.
A rejected patch never modifies the state: read the diagnostic category, fix the patch, retry. Set next.risk before acting, and ask the user before any "destructive" or "external" action.

The same file holds the project's knowledge base: pages saying what the project is, what the user wants from it, how to start working in it, what a feature does and why a decision was taken. Call project_brief first when you have no context — it is one line per page inside a fixed budget. If it reports that the project has no knowledge base, page {"op":"init"} scaffolds the three reserved pages as templates to fill in. Then search before reading anything in full, page with op "get" to read one, and op "put" to write down what you learned. Keep a page summary to one informative line: it is all a cold agent sees before deciding whether to open the page.`;

const USAGE = `state3 MCP server (stdio transport)

Usage: node dist/mcp/server.js [--root <dir>] [--project <name>=<dir>]…

  --root <dir>          task state directory (default: .state3 in the current directory)
  --project <name>=<dir> additional state root the tools may address by name; repeatable
  --help                print this message and exit

Environment:
  STATE3_STATE_DIR  absolute state directory; overrides the cwd-based default.
                        Set it when the host starts the server outside the project:
                        hosts resolve the working directory to their own startup
                        directory, which is not necessarily the project.
  STATE3_PROJECTS   declared project roots, as "name=dir;name2=dir2" or a JSON
                        object of the same. Only roots declared here (or with
                        --project) are reachable through the "project" argument, so
                        the tools can follow a worker in another project without
                        ever writing to an arbitrary directory.

Tools: task_start, task_show, task_patch, task_finish, task_list, task_history, project_brief,
       page, search.
`;

function toToolDescriptor(tool: TaskToolDefinition): Tool {
  return {
    name: tool.name,
    description: tool.description,
    // The tool layer owns JSON Schema; the SDK type is the same shape on the wire.
    inputSchema: tool.inputSchema as Tool['inputSchema'],
  };
}

/**
 * Registers the task tools — and the knowledge-base tools, when a resolver for them is
 * given — on a low-level `Server`: it accepts plain JSON Schema tool definitions, whereas
 * `McpServer.registerTool` requires Zod schemas.
 */
export function createMcpServer(
  resolver: StoreResolver,
  instructions: string = RUNTIME_INSTRUCTIONS,
  kb?: KbResolver,
): Server {
  const tools = [...createTaskTools(resolver), ...(kb === undefined ? [] : createKbTools(kb))];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {} },
    ...(instructions.trim() === '' ? {} : { instructions }),
  });

  server.setRequestHandler(ListToolsRequestSchema, (): ListToolsResult => ({
    tools: tools.map(toToolDescriptor),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const tool = byName.get(request.params.name);
    if (tool === undefined) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
    }
    const result = await tool.handler(request.params.arguments ?? {});
    return {
      content: [{ type: 'text', text: result.content }],
      isError: result.isError === true,
    };
  });

  return server;
}

interface ServerArgs {
  root: string;
  /** Raw `name=dir` declarations, resolved against the startup directory. */
  projects: string[];
  help: boolean;
}

/** The host's startup directory is not necessarily the project, so allow an override. */
function defaultStateDir(): string {
  const fromEnv = process.env.STATE3_STATE_DIR;
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv;
  return '.state3';
}

export function parseServerArgs(argv: readonly string[]): ServerArgs {
  const options: ServerArgs = { root: resolve(defaultStateDir()), projects: [], help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') {
      options.help = true;
      continue;
    }
    if (flag === '--root') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('Missing value for --root');
      options.root = resolve(value);
      i += 1;
      continue;
    }
    if (flag === '--project') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('Missing value for --project');
      options.projects.push(value);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${flag}`);
  }
  return options;
}

/** Environment declarations first, then command-line ones: a repeat is an error. */
export function resolveProjectEntries(
  raw: readonly string[],
  cwd: string = process.cwd(),
): ProjectEntry[] {
  const fromEnv = process.env.STATE3_PROJECTS;
  const entries = fromEnv === undefined ? [] : parseProjectsSpec(fromEnv, cwd);
  for (const declaration of raw) {
    entries.push(...parseProjectsSpec(declaration, cwd));
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.name)) throw new Error(`project "${entry.name}" is declared twice`);
    seen.add(entry.name);
  }
  return entries;
}

/**
 * The knowledge base borrows the task store's connection instead of opening its own. A store
 * that cannot lend one has no pages to serve, and saying so up front beats failing later on a
 * query with no database behind it.
 */
function asDatabaseOwner(store: TaskStorePort): DatabaseOwner {
  const candidate = store as Partial<DatabaseOwner>;
  if (typeof candidate.database !== 'function' || typeof candidate.readable !== 'function') {
    throw new Error(
      'this state root has no knowledge base: its task store does not expose a database connection',
    );
  }
  // The port says nothing about connections; the concrete store always has both.
  return store as unknown as DatabaseOwner;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseServerArgs(argv);
  if (options.help) {
    process.stderr.write(USAGE);
    return;
  }

  // Value imports of the task module live here only: the tool layer stays testable
  // without them, and adapters can inject their own store.
  const [{ TaskStore }, { builtinSkillRegistry }, { createProjectResolver }] = await Promise.all([
    import('../tasks/store.js'),
    import('../tasks/registry.js'),
    import('../tasks/projects.js'),
  ]);

  const skills = builtinSkillRegistry();
  // Every store this process opens, so shutdown can release the database files.
  const opened: TaskStore[] = [];
  const track = (store: TaskStore): TaskStore => {
    opened.push(store);
    return store;
  };

  const primary = track(new TaskStore(options.root, skills));
  // Reported once at startup rather than on every tool answer: a root carried over from the
  // pre-rename name is the difference between resuming this project and starting it over, and
  // repeating that for the rest of the session would cost tokens to say what already happened.
  const carried = primary.carryOverNote();
  const projects = resolveProjectEntries(options.projects);
  const resolver = createProjectResolver(primary, projects, (rootDir) =>
    track(new TaskStore(rootDir, skills)),
  );

  // The knowledge base of each root, borrowing the connection the task store already opened.
  // Cached per store instance, which resolve() hands back unchanged for a given project.
  const kbStores = new WeakMap<TaskStorePort, KbStores>();
  const kb: KbResolver = {
    kb: (project?: string): KbStores => {
      const store = resolver.resolve(project);
      const cached = kbStores.get(store);
      if (cached !== undefined) return cached;
      const owner = asDatabaseOwner(store);
      const made: KbStores = { pages: new PageStore(owner), links: new LinkStore(owner) };
      kbStores.set(store, made);
      return made;
    },
  };

  // Closing folds each write-ahead log back into its database, so a project at rest is a
  // single `state.db` and the file is not left locked for whatever the host does next.
  process.once('exit', () => {
    for (const store of opened) store.close();
  });

  const server = createMcpServer(resolver, RUNTIME_INSTRUCTIONS, kb);
  await server.connect(new StdioServerTransport());
  const declared =
    projects.length === 0 ? '' : `, projects: ${projects.map((p) => p.name).join(', ')}`;
  if (carried !== null) process.stderr.write(`state3: ${carried}\n`);
  process.stderr.write(`state3 MCP server listening on stdio (root: ${options.root}${declared})\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    // stdout carries the protocol; diagnostics must go to stderr.
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
