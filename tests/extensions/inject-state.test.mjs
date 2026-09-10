import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/* The hook is standalone by design (it mirrors the record shape instead of
 * importing src/tasks/*), so the only honest way to test it is to run it: a
 * child process, a state directory on disk, and the JSON it prints. */

const HOOK = resolve('extensions/skillstate/hooks/inject-state.mjs');

function devState(overrides = {}) {
  return {
    goal: 'Ship the adapter',
    status: 'active',
    plan: [{ id: '1', task: 'Write the plugin', status: 'in_progress', notes: '' }],
    artifacts: {},
    verifications: [],
    decisions: [],
    blockers: [],
    next: { action: 'Run the tests', risk: 'safe' },
    ...overrides,
  };
}

function record(id, state, extra = {}) {
  return {
    id,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: extra.updatedAt ?? '2026-09-10T00:00:01.000Z',
    state,
    ...(extra.skill === undefined ? {} : { skill: extra.skill }),
    ...(extra.notation === undefined ? {} : { notation: extra.notation }),
  };
}

let dir;
let stateDir;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'skillstate-hook-'));
  stateDir = join(dir, '.skillstate');
  await mkdir(stateDir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeTask(name, taskRecord) {
  await writeFile(join(stateDir, name), `${JSON.stringify(taskRecord, null, 2)}\n`, 'utf8');
}

/** Runs the hook. `--self-test <dir>` replaces the stdin event; `stdin` overrides it. */
async function runHook({ args = [], env = {}, stdin = null }) {
  const child = spawn(process.execPath, [HOOK, ...args], {
    env: { ...process.env, SKILLSTATE_PROJECTS: '', ...env },
  });
  const out = [];
  const err = [];
  child.stdout.on('data', (chunk) => out.push(chunk));
  child.stderr.on('data', (chunk) => err.push(chunk));
  child.stdin.end(stdin ?? '');
  const code = await new Promise((done) => child.on('close', done));
  return {
    code,
    stdout: Buffer.concat(out).toString('utf8'),
    stderr: Buffer.concat(err).toString('utf8'),
  };
}

const runSelfTest = (env = {}) => runHook({ args: ['--self-test', dir], env });

/** The injected text, or null when the hook stayed silent. */
function contextOf(result) {
  if (result.stdout.trim() === '') return null;
  const parsed = JSON.parse(result.stdout);
  return parsed.hookSpecificOutput.additionalContext;
}

function eventOf(result) {
  return JSON.parse(result.stdout).hookSpecificOutput.hookEventName;
}

describe('inject-state hook', () => {
  it('injects Σ of the active task with its skill and status', async () => {
    await writeTask('task-1.json', record('task-1', devState()));

    const result = await runSelfTest();

    expect(result.code).toBe(0);
    const context = contextOf(result);
    expect(context).toContain('## Active task state (skillstate)');
    expect(context).toContain('Task task-1 [dev-task] (active):');
    expect(context).toContain('"goal":"Ship the adapter"');
    expect(context).toContain('task_patch');
  });

  it('injects a blocked task, because a blocked task is still open', async () => {
    await writeTask(
      'task-1.json',
      record('task-1', devState({ status: 'blocked', blockers: ['waiting on the user'] })),
    );

    const context = contextOf(await runSelfTest());

    expect(context).toContain('Task task-1 [dev-task] (blocked):');
    expect(context).toContain('waiting on the user');
  });

  it('prefers an active task over a blocked one', async () => {
    await writeTask(
      'task-blocked.json',
      record('task-blocked', devState({ status: 'blocked', blockers: ['x'] }), {
        updatedAt: '2026-09-10T05:00:00.000Z',
      }),
    );
    await writeTask(
      'task-active.json',
      record('task-active', devState({ goal: 'The running one' }), {
        updatedAt: '2026-09-10T01:00:00.000Z',
      }),
    );

    const context = contextOf(await runSelfTest());

    expect(context).toContain('task-active');
    expect(context).not.toContain('task-blocked');
  });

  it('prints nothing and exits 0 when only done tasks exist', async () => {
    await writeTask('task-1.json', record('task-1', devState({ status: 'done' })));

    const result = await runSelfTest();

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('');
    expect(contextOf(result)).toBeNull();
  });

  it('prints nothing when the state directory does not exist', async () => {
    await rm(stateDir, { recursive: true, force: true });

    const result = await runSelfTest();

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('names the skill and adds the compact reminder only for a compact task', async () => {
    await writeTask(
      'task-1.json',
      record('task-1', devState({ goal: 'Review the worker' }), {
        skill: 'supervise-task',
        notation: 'compact',
      }),
    );

    const context = contextOf(await runSelfTest());

    expect(context).toContain('[supervise-task]');
    expect(context).toContain('Σ uses compact notation');
  });

  it('omits the compact reminder for a plain task', async () => {
    await writeTask('task-1.json', record('task-1', devState()));

    expect(contextOf(await runSelfTest())).not.toContain('Σ uses compact notation');
  });

  it('asks the agent to compress Σ once it outgrows the O(1) budget', async () => {
    await writeTask('task-1.json', record('task-1', devState({ goal: 'x'.repeat(4200) })));

    const context = contextOf(await runSelfTest());

    expect(context).toContain('compress it');
  });

  it('injects the Σ of a declared project under its own heading', async () => {
    const workerRoot = join(dir, 'worker-state');
    await mkdir(workerRoot, { recursive: true });
    await writeFile(
      join(workerRoot, 'task-w.json'),
      `${JSON.stringify(record('task-w', devState({ goal: 'Build the car' })), null, 2)}\n`,
      'utf8',
    );
    await writeTask('task-1.json', record('task-1', devState()));

    const result = await runSelfTest({ SKILLSTATE_PROJECTS: `worker=${workerRoot}` });
    const context = contextOf(result);

    expect(context).toContain('## Supervised projects (skillstate)');
    expect(context).toContain(`### worker — ${workerRoot}`);
    expect(context).toContain('Build the car');
    expect(context).toContain('task_patch {"project":"<name>"');
  });

  it('skips a declared project with no open task, keeping the primary section', async () => {
    const emptyRoot = join(dir, 'empty-state');
    await mkdir(emptyRoot, { recursive: true });
    await writeTask('task-1.json', record('task-1', devState()));

    const result = await runSelfTest({ SKILLSTATE_PROJECTS: `worker=${emptyRoot}` });

    expect(contextOf(result)).toContain('## Active task state (skillstate)');
    expect(result.stdout).not.toContain('## Supervised projects');
  });

  it('ignores a malformed project declaration instead of failing the turn', async () => {
    await writeTask('task-1.json', record('task-1', devState()));

    const result = await runSelfTest({ SKILLSTATE_PROJECTS: 'not a declaration' });

    expect(result.code).toBe(0);
    expect(contextOf(result)).toContain('Task task-1');
    expect(result.stdout).not.toContain('## Supervised projects');
  });

  it('survives a torn state file next to a valid one', async () => {
    await writeFile(join(stateDir, 'task-broken.json'), '{"id": "task-broken", "state":', 'utf8');
    await writeTask('task-1.json', record('task-1', devState()));

    const result = await runSelfTest();

    expect(result.code).toBe(0);
    expect(contextOf(result)).toContain('Task task-1');
  });

  it('leads with the compaction wording on PreCompact and names that event', async () => {
    await writeTask('task-1.json', record('task-1', devState()));

    const result = await runHook({
      stdin: JSON.stringify({ hook_event_name: 'PreCompact', cwd: dir }),
    });

    expect(eventOf(result)).toBe('PreCompact');
    expect(contextOf(result)).toContain('The conversation is about to be compacted');
  });

  it('answers SessionStart with the resume wording', async () => {
    await writeTask('task-1.json', record('task-1', devState()));

    const result = await runHook({
      stdin: JSON.stringify({ hook_event_name: 'SessionStart', cwd: dir }),
    });

    expect(eventOf(result)).toBe('SessionStart');
    expect(contextOf(result)).toContain('Resume from the task state below');
  });

  it('treats an unknown or missing event as UserPromptSubmit', async () => {
    await writeTask('task-1.json', record('task-1', devState()));

    const unknown = await runHook({ stdin: JSON.stringify({ hook_event_name: 'Stop', cwd: dir }) });
    expect(eventOf(unknown)).toBe('UserPromptSubmit');

    const garbage = await runHook({ stdin: 'not json at all' });
    expect(garbage.code).toBe(0);
    expect(eventOf(garbage)).toBe('UserPromptSubmit');
  });

  it('honours SKILLSTATE_STATE_DIR over the reported cwd', async () => {
    const pinned = join(dir, 'pinned');
    await mkdir(pinned, { recursive: true });
    await writeFile(
      join(pinned, 'task-p.json'),
      `${JSON.stringify(record('task-p', devState({ goal: 'Pinned root' })), null, 2)}\n`,
      'utf8',
    );

    const result = await runHook({
      args: ['--self-test', dir],
      env: { SKILLSTATE_STATE_DIR: pinned },
    });

    expect(contextOf(result)).toContain('Pinned root');
  });
});
