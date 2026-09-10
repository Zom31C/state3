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
const client = new Client({ name: 'mcp-smoke', version: '0.0.0' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, '--root', root],
    stderr: 'pipe',
  }),
);

const text = (result) => String(result.content[0].text);
const call = (name, args) => client.callTool({ name, arguments: args });

try {
  const list = await client.listTools();
  const names = list.tools.map((t) => t.name).sort();
  check(
    'tools/list exposes the six task tools',
    names.join(',') ===
      'task_finish,task_history,task_list,task_patch,task_show,task_start'
        .split(',')
        .sort()
        .join(','),
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

  const listed = await call('task_list', {});
  check('task_list reports the task', text(listed).includes('Tasks (1)'), text(listed).trim());

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
