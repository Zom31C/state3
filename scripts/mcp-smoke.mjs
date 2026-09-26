import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
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
      '--server expects a path, for example --server extensions/state3/bin/state3-mcp.mjs',
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

const root = mkdtempSync(join(tmpdir(), 'state3-mcp-'));
// A second root, declared by name: the scaffolding is exercised on a project that holds nothing
// yet, and the "project" argument — which no other check here reaches — is exercised at all.
const kbRoot = mkdtempSync(join(tmpdir(), 'state3-mcp-kb-'));
const client = new Client({ name: 'mcp-smoke', version: '0.0.0' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, '--root', root],
    env: { ...process.env, STATE3_PROJECTS: `kbinit=${kbRoot}` },
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
        join(process.cwd(), 'extensions', 'state3', 'hooks', 'inject-state.mjs'),
        '--self-test',
        root,
        ...(eventName === null ? [] : [eventName]),
      ],
      {
        encoding: 'utf8',
        // `--self-test <dir>` makes the hook append `.state3`, and the server was started
        // with the state root itself, so the root has to be pinned explicitly.
        env: {
          ...process.env,
          STATE3_HOME: process.cwd(),
          STATE3_PROJECTS: '',
          STATE3_STATE_DIR: root,
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
      !subagentHook.context.includes('## Project brief (state3)'),
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
  const authPage = await call('page', {
    op: 'put',
    id: 'auth',
    kind: 'feature',
    title: 'Authentication',
    summary: 'Who is asking.',
    body: 'Tokens are verified by the quixotic middleware.',
    symbols: ['TokenVerifier — src/auth/verify.ts'],
  });
  check(
    'page put stores a page with its symbol list',
    authPage.isError !== true && text(authPage).includes('Stored page auth'),
    text(authPage).split('\n')[0],
  );

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
    'page get returns the body, the symbols and the edge',
    text(got).includes('quixotic middleware') &&
      text(got).includes('symbols:') &&
      text(got).includes('TokenVerifier — src/auth/verify.ts') &&
      text(got).includes(`-[documents]-> task:${taskId}`),
  );

  const found = await call('search', { query: 'quixotic' });
  check(
    'search finds the page by a word in its body',
    text(found).includes('- page:auth'),
    text(found).split('\n')[1],
  );

  // The symbol column is the one that answers "where does this live" without opening a body,
  // so the hit has to carry the file and not just the page.
  const bySymbol = await call('search', { query: 'TokenVerifier' });
  check(
    'search finds a page by a symbol and the snippet names the file',
    text(bySymbol).includes('- page:auth') &&
      text(bySymbol).includes('[TokenVerifier]') &&
      text(bySymbol).includes('src/auth/verify.ts'),
    text(bySymbol).split('\n')[1],
  );

  // A miss is the answer an agent has to act on next, so it says what is nearest and where to
  // look instead of stopping at "nothing".
  const miss = await call('search', { query: 'AuthenticationMiddleware' });
  check(
    'search names the nearest pages on a miss instead of stopping at "nothing"',
    text(miss).includes('nothing matches "AuthenticationMiddleware"') &&
      text(miss).includes('Nearest pages by topic') &&
      text(miss).includes('- auth: Authentication') &&
      text(miss).includes('symbols'),
    text(miss)
      .split('\n')
      .find((line) => line.startsWith('- ')) ?? '',
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
    startHook.context.includes('## Project brief (state3)') &&
      startHook.context.includes('- project: One line a cold agent reads first.') &&
      startHook.context.includes('Smoke the stdio MCP server') &&
      startHook.context.indexOf('## Active task state') <
        startHook.context.indexOf('## Project brief') &&
      !startHook.context.includes('quixotic'),
    startHook.context.split('\n')[0],
  );
  check(
    'inject-state hook keeps the brief out of a prompt',
    !runHook().context.includes('## Project brief (state3)'),
  );

  // Σ describes a tree, and a tree can be changed by hand between sessions. The stamp a patch
  // records is what makes that visible: without it a resumed session reads Σ as an account of
  // the files as they are now, and reasons from a premise that stopped being true overnight.
  const driftedFile = join(root, 'drifted.ts');
  writeFileSync(driftedFile, 'one');
  await call('task_patch', { patch: { artifacts: { 'drifted.ts': 'the file under test' } } });
  check(
    'task_show says nothing about an artifact the tree still matches',
    !text(await call('task_show', {})).includes('Artifacts changed on disk'),
  );

  writeFileSync(driftedFile, 'one two three, changed by hand overnight');
  const driftedShow = text(await call('task_show', {}));
  check(
    'task_show names an artifact whose file changed after Σ was written',
    driftedShow.includes('Artifacts changed on disk since Σ was last written') &&
      driftedShow.includes('drifted.ts (modified'),
    driftedShow.split('\n').find((line) => line.includes('Artifacts changed')) ?? '',
  );
  check(
    'inject-state hook carries the drift at session start, and not on every prompt',
    runHook('SessionStart').context.includes('Artifacts changed on disk') &&
      !runHook().context.includes('Artifacts changed on disk'),
  );

  // The opencode plugin is the third reader of the same file, and the one that runs under Bun in
  // production: it has to reach the build the same way the hook does, or a migrated project
  // silently loses both Σ and the guard that reads next.risk.
  const plugin = spawnSync(
    process.execPath,
    [join(process.cwd(), 'adapters', 'opencode', 'plugin', 'state3.js'), '--self-test', root],
    {
      encoding: 'utf8',
      env: { ...process.env, STATE3_HOME: process.cwd(), STATE3_STATE_DIR: root },
    },
  );
  const pluginOut = String(plugin.stdout ?? '');
  check(
    'opencode plugin injects Σ and the brief out of the database',
    plugin.status === 0 &&
      pluginOut.includes('## Active task state (state3)') &&
      pluginOut.includes('Smoke the stdio MCP server') &&
      pluginOut.includes('## Project brief (state3)') &&
      pluginOut.includes('- project: One line a cold agent reads first.') &&
      !pluginOut.includes('quixotic'),
    pluginOut.split('\n')[0] || String(plugin.stderr ?? '').split('\n')[0],
  );

  const deleted = await call('page', { op: 'delete', id: 'auth' });
  check('page delete removes the page', text(deleted).includes('Deleted page auth'), text(deleted));

  // Partial body edits, their trail and the anchor. A build that predates these ops does not
  // have them at all, which makes this block the gate that catches a server still serving an
  // older dist — the failure mode measured in §9 and again in §14.9.
  await call('page', {
    op: 'put',
    id: 'car',
    kind: 'note',
    title: 'Car physics',
    summary: 'What the integrity bar reads.',
    body: '# Car\n\nSpeed lives in scripts/Car.cs.\n\n## Hud\n\nThe bar is drawn from scripts/Hud.cs.',
  });

  const patchedBody = await call('page', {
    op: 'patch',
    id: 'car',
    edits: [
      { find: 'Speed lives', replace: 'Top speed lives' },
      { after: 'Top speed lives in scripts/Car.cs.', insert: 'Grip lives beside it.' },
    ],
  });
  check(
    'page patch edits a body in place, each edit seeing what the previous one wrote',
    patchedBody.isError !== true && text(patchedBody).includes('Patched page car (2 edits)'),
    text(patchedBody).split('\n')[0],
  );

  const ambiguous = await call('page', {
    op: 'patch',
    id: 'car',
    edits: [
      { find: 'Grip lives beside it.', replace: 'Grip lives beside the speed.' },
      { find: 'scripts/', replace: 'src/' },
    ],
  });
  check(
    'an edit whose address is not unique is refused by number',
    ambiguous.isError === true &&
      text(ambiguous).includes('edit 2') &&
      text(ambiguous).includes('matches 2 times'),
    text(ambiguous).split('\n')[0],
  );

  const afterRefusal = await call('page', { op: 'get', id: 'car' });
  check(
    'a refused edit left the body exactly as it was',
    text(afterRefusal).includes('Grip lives beside it.') &&
      text(afterRefusal).includes('scripts/Hud.cs'),
  );

  const appended = await call('page', { op: 'append', id: 'car', body: 'Measured on the ramp.' });
  check(
    'page append adds to the end of a body and reports the size it reached',
    appended.isError !== true && text(appended).includes('chars to page car'),
    text(appended).split('\n')[0],
  );

  const versions = await call('page', { op: 'history', id: 'car' });
  check(
    'page history lists the bodies the page had',
    text(versions).includes('Previous bodies of page car (') && text(versions).includes('#1'),
    text(versions).split('\n')[0],
  );

  const revision = await call('page', { op: 'history', id: 'car', revision: 1 });
  check(
    'page history reads one previous body back by its #seq',
    revision.isError !== true &&
      text(revision).includes('body as of') &&
      text(revision).includes('Speed lives in scripts/Car.cs.'),
    text(revision).split('\n')[0],
  );

  const anchored = await call('page', { op: 'get', id: 'car' });
  check(
    'page get says what the body is anchored to',
    text(anchored).includes('source:') && text(anchored).includes('scripts/Car.cs'),
    text(anchored)
      .split('\n')
      .find((line) => line.startsWith('source:')) ?? '',
  );

  const stale = await call('page', { op: 'stale' });
  check(
    'page stale answers for a tree with no repository to ask',
    stale.isError !== true && text(stale).includes('no page names a file that changed'),
    text(stale).split('\n')[0],
  );

  // The Σ half of the same review: a step archived by id, a verification stamped by the runtime,
  // an element removed by a path key, and the size report that says what to compress first.
  const compressed = await call('task_patch', {
    patch: {
      'plan[id=1].archived': true,
      'verifications[+]': { check: 'npm run lint', status: 'pass' },
    },
  });
  check(
    'a path key archives a finished step by its id and appends a verification',
    compressed.isError !== true &&
      text(compressed).includes('"archived":true') &&
      text(compressed).includes('npm run lint'),
    text(compressed).split('\n')[0],
  );
  check(
    'the runtime stamps a verification with the time and the commit it was recorded at',
    text(compressed).includes('"at":"') && text(compressed).includes('"commit":'),
    text(compressed).split('\n')[0],
  );

  const removed = await call('task_patch', { patch: { 'verifications[0]': null } });
  // The Σ line, not the whole answer: a note under it quotes what the patch cost, and a check
  // that greps the answer would read that quote as the element still being in Σ.
  const removedState =
    text(removed)
      .split('\n')
      .find((line) => line.startsWith('{')) ?? '';
  check(
    'a path key with null removes one array element',
    removed.isError !== true &&
      !removedState.includes('npm test') &&
      removedState.includes('npm run lint'),
    removedState.slice(0, 90),
  );
  check(
    'removing a verification names the stamp it took with it, instead of losing it silently',
    text(removed).includes('1 verification stamp(s) are no longer attached') &&
      text(removed).includes('"npm test" was at'),
    text(removed)
      .split('\n')
      .find((line) => line.startsWith('Note:'))
      ?.slice(0, 90) ?? '',
  );

  const sizes = await call('task_show', { view: 'size' });
  check(
    'task_show {"view":"size"} reports the fields by cost and carries no Σ',
    sizes.isError !== true &&
      text(sizes).includes('largest first') &&
      !text(sizes).includes('"goal"') &&
      !text(sizes).includes('## How to keep this state (P)'),
    text(sizes).split('\n')[0],
  );

  // The tree, end to end: work split into subtasks is queued in rows, so a prompt stops carrying
  // it. Checked through the real server and the real hook, because what it buys is exactly what
  // a prompt no longer pays for, and no unit test sees the prompt.
  const subtaskId = (result) => String(text(result).match(/Started task (\S+)/)?.[1] ?? '');
  const pieceOne = await call('task_start', { goal: 'Piece one of the smoke', parent: taskId });
  const pieceTwo = await call('task_start', { goal: 'Piece two of the smoke', parent: taskId });
  check(
    'task_start splits a piece out of a task and queues it instead of starting it',
    pieceOne.isError !== true &&
      text(pieceOne).includes('"status":"pending"') &&
      text(pieceOne).includes(`Queued as a subtask of ${taskId}`),
    text(pieceOne).split('\n')[0],
  );

  const treeList = await call('task_list', {});
  check(
    'task_list prints the decomposition as a tree, with the queue counted on its parent',
    text(treeList).includes('Tasks (3)') &&
      text(treeList).includes('(2 subtasks, 2 open)') &&
      /^ {2}- task-/m.test(text(treeList)),
    text(treeList).split('\n')[1],
  );

  const treeView = await call('task_show', { id: taskId, view: 'tree' });
  check(
    'task_show {"view":"tree"} answers with the decomposition and carries no Σ',
    treeView.isError !== true &&
      text(treeView).includes('Piece one of the smoke') &&
      text(treeView).includes('Piece two of the smoke') &&
      !text(treeView).includes('"goal"'),
    text(treeView).split('\n')[0],
  );

  const branchHook = runHook('UserPromptSubmit');
  check(
    'the injection carries the branch and the next sibling, and no queued state',
    branchHook.context.includes('Branch: Smoke the stdio MCP server [active] -> this task') &&
      branchHook.context.includes('Queued after this: "Piece two of the smoke"') &&
      // The sibling behind the work in flight is named, not carried: its Σ is what a flat plan
      // would have put in the prompt on every turn of the piece being worked on.
      !branchHook.context.includes('"goal":"Piece two of the smoke"'),
    branchHook.context.split('\n').find((line) => line.startsWith('Branch:')) ?? '(no branch line)',
  );

  // A cold session lands on whatever is at the frontier, and a decomposition is never it: the
  // parent is a container and its pieces are only queued. Without this line the queue is
  // invisible to a session that starts here, and the session begins new work beside it instead
  // of resuming what was split — which is exactly what the first cold run of this build did.
  const unrelated = await call('task_start', { goal: 'Another job in flight' });
  const coldHook = runHook('SessionStart');
  check(
    'a session start names the open work the frontier did not pick',
    coldHook.context.includes(`Task ${subtaskId(unrelated)}`) &&
      coldHook.context.includes(
        'Also open elsewhere: 2 queued in 1 decomposition, 1 other open root',
      ),
    coldHook.context.split('\n').find((line) => line.startsWith('Also open')) ?? '(no line)',
  );

  const closingEarly = await call('task_finish', { summary: 'Tried to close early', id: taskId });
  check(
    'a decomposition cannot be closed while a subtask is still open',
    closingEarly.isError === true && text(closingEarly).includes('open subtask'),
    text(closingEarly).split('\n')[0],
  );

  // Moving a task is the one patch Σ cannot show — the parent is a column, and the state renders
  // the same before and after — so both the refusal and the confirmation have to be words.
  const cycle = await call('task_patch', { patch: { parent: subtaskId(pieceOne) }, id: taskId });
  check(
    'a task cannot be moved under its own subtask, and the refusal says why',
    cycle.isError === true &&
      text(cycle).includes('would make it its own ancestor') &&
      !text(cycle).includes('unknown-key'),
    text(cycle).split('\n')[0],
  );

  const moved = await call('task_patch', {
    patch: { parent: subtaskId(unrelated) },
    id: subtaskId(pieceTwo),
  });
  check(
    'a patch re-files a task under another one and names both ends of the move',
    moved.isError !== true &&
      text(moved).includes(`Moved from ${taskId} under ${subtaskId(unrelated)}`),
    text(moved)
      .split('\n')
      .find((line) => line.startsWith('Moved')) ?? '(no move line)',
  );

  await call('task_finish', { summary: 'Piece one done', id: subtaskId(pieceOne) });
  await call('task_finish', { summary: 'Piece two done', id: subtaskId(pieceTwo) });
  // Closed before the parent so the last `task_finish` below, which names no id, finds the
  // decomposition and not this one.
  await call('task_finish', { summary: 'Another job done', id: subtaskId(unrelated) });

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
