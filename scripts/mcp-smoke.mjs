import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function serverPathFrom(argv) {
  const index = argv.indexOf('--server');
  if (index === -1) return join(process.cwd(), 'dist', 'mcp', 'server.js');
  const value = argv[index + 1];
  if (value === undefined) {
    console.error(
      '--server expects a path, for example --server extensions/skillstate/bin/skillstate-mcp.mjs',
    );
    process.exit(1);
  }
  return resolve(value);
}

const serverPath = serverPathFrom(process.argv.slice(2));
if (!existsSync(serverPath)) {
  console.error(`${serverPath} not found — run "npm run build" first.`);
  process.exitCode = 1;
  process.exit(1);
}

const checks = [];
const check = (label, ok, detail = '') => {
  checks.push({ label, ok: ok === true });
  console.log(`${ok === true ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`);
};

const root = mkdtempSync(join(tmpdir(), 'skillstate-mcp-'));
// A second root, declared by name: the scaffolding is exercised on a project that holds nothing
// yet, and the "project" argument — which no other check here reaches — is exercised at all.
const kbRoot = mkdtempSync(join(tmpdir(), 'skillstate-mcp-kb-'));
const client = new Client({ name: 'mcp-smoke', version: '0.0.0' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, '--root', root],
    env: { ...process.env, SKILLSTATE_PROJECTS: `kbinit=${kbRoot}` },
    stderr: 'pipe',
  }),
);

const text = (result) => String(result.content[0].text);
const call = (name, args) => client.callTool({ name, arguments: args });

try {
  const list = await client.listTools();
  const names = list.tools.map((t) => t.name).sort();
  const expectedTools =
    'task_finish,task_history,task_list,task_patch,task_show,task_start,project_brief,page,search'
      .split(',')
      .sort()
      .join(',');
  check(
    'tools/list exposes the task tools and the knowledge-base tools',
    names.join(',') === expectedTools,
    names.join(', '),
  );
  check(
    'every tool has an object input schema and a description',
    list.tools.every((t) => t.inputSchema?.type === 'object' && (t.description ?? '').length > 0),
  );

  const started = await call('task_start', {
    goal: 'Smoke the stdio MCP server',
    plan: ['Step one', 'Step two'],
  });
  check('task_start creates a task', started.isError !== true, text(started).split('\n')[0]);

  const unknownKey = await call('task_patch', { patch: { bogus: 1 } });
  check(
    'task_patch rejects an unknown key',
    unknownKey.isError === true && text(unknownKey).includes('unknown-key'),
    text(unknownKey).split('\n')[0],
  );

  const valid = await call('task_patch', {
    patch: {
      plan: [
        { id: '1', task: 'Step one', status: 'done', notes: 'smoke' },
        { id: '2', task: 'Step two', status: 'in_progress', notes: '' },
      ],
      verifications: [{ check: 'npm test', status: 'pass' }],
      next: { action: 'Run step two', risk: 'safe' },
    },
  });
  check('task_patch applies a valid patch', valid.isError !== true);

  const reopen = await call('task_patch', {
    patch: {
      plan: [
        { id: '1', task: 'Step one', status: 'pending', notes: '' },
        { id: '2', task: 'Step two', status: 'in_progress', notes: '' },
      ],
    },
  });
  check(
    'task_patch rejects reopening a done plan item without notes',
    reopen.isError === true && text(reopen).includes('guard'),
    text(reopen).split('\n')[0],
  );

  const shown = await call('task_show', {});
  const state = text(shown);
  check(
    'task_show returns the compact state plus the procedure P',
    state.includes('## How to keep this state (P)') && state.split('\n')[1].startsWith('{'),
  );
  check(
    'rejected patches left the state untouched',
    !state.includes('"bogus"') && state.includes('"id":"1","task":"Step one","status":"done"'),
  );

  // The hook is the other reader of state.db, and the one that fires on every prompt: it
  // resolves dist/tasks/inject.js and injects Σ without spending a tool call. Checked here
  // because this script is the only gate that runs against a build rather than against src.
  /** Runs the hook against this root for one event (default: a prompt), as the host would. */
  const runHook = (eventName = null) => {
    const run = spawnSync(
      process.execPath,
      [
        join(process.cwd(), 'extensions', 'skillstate', 'hooks', 'inject-state.mjs'),
        '--self-test',
        root,
        ...(eventName === null ? [] : [eventName]),
      ],
      {
        encoding: 'utf8',
        // `--self-test <dir>` makes the hook append `.skillstate`, and the server was started
        // with the state root itself, so the root has to be pinned explicitly.
        env: {
          ...process.env,
          SKILLSTATE_HOME: process.cwd(),
          SKILLSTATE_PROJECTS: '',
          SKILLSTATE_STATE_DIR: root,
        },
      },
    );
    let context = '';
    try {
      context = String(JSON.parse(run.stdout).hookSpecificOutput.additionalContext);
    } catch {
      context = '';
    }
    return { status: run.status, stderr: String(run.stderr ?? ''), context };
  };

  const hook = runHook();
  const hookContext = hook.context;
  check(
    'inject-state hook injects Σ straight out of the database',
    hookContext.includes('Smoke the stdio MCP server') && hookContext.includes('(active)'),
    hookContext.split('\n')[0],
  );
  check(
    'inject-state hook reads the database without a warning',
    hook.status === 0 && hook.stderr.trim() === '',
    hook.stderr.trim() === '' ? `exit ${hook.status}` : hook.stderr.trim().split('\n')[0],
  );

  // A delegated subagent starts with no transcript, so it is told what is in flight — but it
  // carries those lines on every one of its own turns, which is why it gets orientation and
  // not Σ. Checked here, against a real database, because the brief is rendered by the build.
  const subagentHook = runHook('SubagentStart');
  check(
    'inject-state hook orients a subagent with the goal and next step instead of Σ',
    subagentHook.context.includes('delegated a subtask') &&
      subagentHook.context.includes('goal: Smoke the stdio MCP server') &&
      subagentHook.context.includes('next: ') &&
      !subagentHook.context.includes('"artifacts"') &&
      !subagentHook.context.includes('## Project brief (skillstate)'),
    subagentHook.context.split('\n')[0],
  );

  const listed = await call('task_list', {});
  check('task_list reports the task', text(listed).includes('Tasks (1)'), text(listed).trim());

  // A project that has never held a page: scaffolding is what turns "document this project" into
  // three pages with headings, and it must not touch a page that is already there.
  const inited = await call('page', { op: 'init', project: 'kbinit' });
  check(
    'page init scaffolds the three reserved pages of a declared project',
    text(inited).includes('Scaffolded 3 template page(s): project, user-intent, onboarding.'),
    text(inited).split('\n')[0],
  );
  const reinited = await call('page', { op: 'init', project: 'kbinit' });
  check(
    'page init overwrites nothing on a second call',
    text(reinited).includes('Nothing to scaffold'),
    text(reinited).split('\n')[0],
  );
  const guide = await call('page', { op: 'get', id: 'onboarding', project: 'kbinit' });
  check(
    'the onboarding template is the guide for an agent with no context',
    text(guide).includes('(stale)') &&
      text(guide).includes('project_brief') &&
      text(guide).includes('task_patch'),
    text(guide).split('\n')[0],
  );
  const templateBrief = await call('project_brief', { project: 'kbinit' });
  check(
    'the brief of a scaffolded project shows the templates and no template body',
    text(templateBrief).includes('- project (stale): TEMPLATE') &&
      !text(templateBrief).includes('replace every'),
    text(templateBrief).split('\n')[0],
  );

  // The knowledge base shares the task store's connection, so it is exercised through the
  // same server process: a page write, a link to the live task, a read back, and a search
  // that has to find both halves of the database.
  const taskId = String(text(started).match(/Started task (\S+)/)?.[1] ?? '');
  const stored = await call('page', {
    op: 'put',
    id: 'project',
    kind: 'project',
    title: 'Smoke project',
    summary: 'One line a cold agent reads first.',
    pin: true,
  });
  check(
    'page put stores the singleton project page',
    text(stored).includes('Stored page project'),
    text(stored).split('\n')[0],
  );
  await call('page', {
    op: 'put',
    id: 'auth',
    kind: 'feature',
    title: 'Authentication',
    summary: 'Who is asking.',
    body: 'Tokens are verified by the quixotic middleware.',
  });

  const refusal = await call('page', {
    op: 'put',
    id: 'overview',
    kind: 'project',
    title: 'Overview',
    summary: 'Not the singleton id.',
  });
  check(
    'page put refuses a singleton kind under another id',
    refusal.isError === true && text(refusal).includes('Refused (guard)'),
    text(refusal).split('\n')[0],
  );

  const linked = await call('page', {
    op: 'link',
    from: 'page:auth',
    rel: 'documents',
    to: `task:${taskId}`,
  });
  check(
    'page link connects a page to the live task',
    text(linked).includes('Linked page:auth'),
    text(linked),
  );

  const got = await call('page', { op: 'get', id: 'auth' });
  check(
    'page get returns the body and the edge',
    text(got).includes('quixotic middleware') &&
      text(got).includes(`-[documents]-> task:${taskId}`),
  );

  const found = await call('search', { query: 'quixotic' });
  check(
    'search finds the page by a word in its body',
    text(found).includes('- page:auth'),
    text(found).split('\n')[1],
  );

  const foundTask = await call('search', { query: 'Smoke', kind: 'task' });
  check(
    'search finds the task by its goal',
    foundTask.isError !== true && text(foundTask).includes(`task:${taskId}`),
    text(foundTask).split('\n')[1],
  );

  const pages = await call('page', { op: 'list' });
  check(
    'page list shows summaries without bodies',
    text(pages).includes('Pages (2):') && !text(pages).includes('quixotic'),
    text(pages).split('\n')[0],
  );

  const brief = await call('project_brief', {});
  check(
    'project_brief maps the project without carrying a single page body',
    brief.isError !== true &&
      text(brief).includes('# Project brief') &&
      text(brief).includes('- project: One line a cold agent reads first.') &&
      text(brief).includes('Authentication') &&
      !text(brief).includes('quixotic'),
    text(brief).split('\n')[0],
  );

  // The hook is the reader that costs no tool call: at session start it injects the same map,
  // and on a prompt it stays out, because the session has already seen it and would pay for it
  // on every turn that follows.
  const startHook = runHook('SessionStart');
  check(
    'inject-state hook adds the project brief at session start, Σ still first',
    startHook.context.includes('## Project brief (skillstate)') &&
      startHook.context.includes('- project: One line a cold agent reads first.') &&
      startHook.context.includes('Smoke the stdio MCP server') &&
      startHook.context.indexOf('## Active task state') <
        startHook.context.indexOf('## Project brief') &&
      !startHook.context.includes('quixotic'),
    startHook.context.split('\n')[0],
  );
  check(
    'inject-state hook keeps the brief out of a prompt',
    !runHook().context.includes('## Project brief (skillstate)'),
  );

  // The opencode plugin is the third reader of the same file, and the one that runs under Bun in
  // production: it has to reach the build the same way the hook does, or a migrated project
  // silently loses both Σ and the guard that reads next.risk.
  const plugin = spawnSync(
    process.execPath,
    [join(process.cwd(), 'adapters', 'opencode', 'plugin', 'skillstate.js'), '--self-test', root],
    {
      encoding: 'utf8',
      env: { ...process.env, SKILLSTATE_HOME: process.cwd(), SKILLSTATE_STATE_DIR: root },
    },
  );
  const pluginOut = String(plugin.stdout ?? '');
  check(
    'opencode plugin injects Σ and the brief out of the database',
    plugin.status === 0 &&
      pluginOut.includes('## Active task state (skillstate)') &&
      pluginOut.includes('Smoke the stdio MCP server') &&
      pluginOut.includes('## Project brief (skillstate)') &&
      pluginOut.includes('- project: One line a cold agent reads first.') &&
      !pluginOut.includes('quixotic'),
    pluginOut.split('\n')[0] || String(plugin.stderr ?? '').split('\n')[0],
  );

  const deleted = await call('page', { op: 'delete', id: 'auth' });
  check('page delete removes the page', text(deleted).includes('Deleted page auth'), text(deleted));

  const history = await call('task_history', { limit: 10 });
  check(
    'task_history audits both rejected patches',
    text(history).includes('REJECTED (unknown-key)') && text(history).includes('REJECTED (guard)'),
    `${text(history).split('\n').length - 1} entries`,
  );

  const finished = await call('task_finish', { summary: 'Smoke passed' });
  check(
    'task_finish marks the task done',
    finished.isError !== true && text(finished).includes('(done)'),
    text(finished).split('\n')[0],
  );

  const missing = await call('task_show', {});
  check(
    'task_show reports a missing active task as a tool error, not a crash',
    missing.isError === true && text(missing).includes('No task found'),
    text(missing).split('\n')[0],
  );
} finally {
  await client.close();
}

const failed = checks.filter((c) => !c.ok);
console.log(
  `\n${checks.length - failed.length}/${checks.length} checks passed ` +
    `(server: ${serverPath}, state root: ${root})`,
);
if (failed.length > 0) {
  console.error(`failed: ${failed.map((c) => c.label).join('; ')}`);
  process.exitCode = 1;
}
