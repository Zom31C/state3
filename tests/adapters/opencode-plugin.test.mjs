import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { State3 } from '../../adapters/opencode/plugin/state3.js';

function makeRecord(overrides = {}) {
  return {
    id: 'task-1',
    createdAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:01.000Z',
    state: {
      goal: 'Ship the adapter',
      status: 'active',
      plan: [{ id: '1', task: 'Write the plugin', status: 'in_progress', notes: '' }],
      artifacts: {},
      verifications: [],
      decisions: [],
      blockers: [],
      next: { action: 'Run the tests', risk: 'safe' },
      ...overrides,
    },
  };
}

let projectDir;
let logs;

const client = () => ({
  app: {
    log: async (entry) => {
      logs.push(entry);
    },
  },
});

async function writeTask(record, name = 'task-1.json') {
  await writeFile(join(projectDir, '.state3', name), `${JSON.stringify(record, null, 2)}\n`);
}

async function loadHooks() {
  return State3({ directory: projectDir, worktree: projectDir, client: client() });
}

beforeEach(async () => {
  logs = [];
  projectDir = await mkdtemp(join(tmpdir(), 'state3-opencode-'));
  await mkdir(join(projectDir, '.state3'), { recursive: true });
});

afterEach(async () => {
  delete process.env.STATE3_GUARD;
  delete process.env.STATE3_NO_SYSTEM;
  delete process.env.STATE3_ROOT;
  delete process.env.STATE3_STATE_DIR;
  await rm(projectDir, { recursive: true, force: true });
});

describe('state3 opencode plugin', () => {
  it('registers the compaction hook and pushes Σ into the compaction context', async () => {
    await writeTask(makeRecord());
    const hooks = await loadHooks();
    const output = { context: [] };

    await hooks['experimental.session.compacting']({ sessionID: 's1' }, output);

    expect(output.context).toHaveLength(1);
    expect(output.context[0]).toContain('## Active task state (state3)');
    expect(output.context[0]).toContain('about to be compacted');
    expect(output.context[0]).toContain('Task task-1 (active):');
  });

  it('pushes the compact single-line Σ into the system prompt of a request', async () => {
    await writeTask(makeRecord());
    const hooks = await loadHooks();
    const output = { system: ['You are a coding agent.'] };

    await hooks['experimental.chat.system.transform']({ model: {} }, output);

    expect(output.system).toHaveLength(2);
    const injected = output.system[1];
    expect(injected.split('\n')[2]).toBe('Task task-1 (active):');
    expect(injected.split('\n')[3]).toBe(JSON.stringify(makeRecord().state));
    expect(injected).not.toContain('about to be compacted');
  });

  it('skips the system hook when STATE3_NO_SYSTEM=1', async () => {
    await writeTask(makeRecord());
    process.env.STATE3_NO_SYSTEM = '1';

    const hooks = await loadHooks();

    expect(hooks['experimental.chat.system.transform']).toBeUndefined();
    expect(hooks['experimental.session.compacting']).toBeTypeOf('function');
  });

  it('injects nothing when there is no active task and does not fail', async () => {
    const hooks = await loadHooks();
    const compacting = { context: [] };
    const system = { system: [] };

    await hooks['experimental.session.compacting']({ sessionID: 's1' }, compacting);
    await hooks['experimental.chat.system.transform']({ model: {} }, system);

    expect(compacting.context).toEqual([]);
    expect(system.system).toEqual([]);
  });

  it('ignores a finished task and a corrupt state file', async () => {
    await writeTask(makeRecord({ status: 'done' }), 'task-done.json');
    await writeFile(join(projectDir, '.state3', 'task-broken.json'), '{not json');
    const hooks = await loadHooks();
    const output = { context: [] };

    await hooks['experimental.session.compacting']({ sessionID: 's1' }, output);

    expect(output.context).toEqual([]);
  });

  it('treats a root with state.db as authoritative, and says so when it cannot read it', async () => {
    // A migrated root archives the JSON it replaced, so falling back to those files would inject
    // a Σ that is already out of date: the plugin reports the database instead. The database here
    // is not one, which gives the same answer whether or not a build is reachable — and this suite
    // must not depend on dist being newer than src.
    await writeTask(makeRecord());
    await writeFile(join(projectDir, '.state3', 'state.db'), 'this is not a database\n');
    const hooks = await loadHooks();
    const output = { context: [] };

    await hooks['experimental.session.compacting']({ sessionID: 's1' }, output);

    expect(output.context).toEqual([]);
    const warn = logs.find((entry) => entry.body.level === 'warn');
    expect(warn?.body.message).toContain('state.db');
  });

  it('picks the most recently updated active task', async () => {
    await writeTask({ ...makeRecord(), id: 'task-old', updatedAt: '2026-09-05T00:00:01.000Z' });
    await writeTask(
      { ...makeRecord(), id: 'task-new', updatedAt: '2026-09-05T09:00:00.000Z' },
      'task-2.json',
    );
    const hooks = await loadHooks();
    const output = { context: [] };

    await hooks['experimental.session.compacting']({ sessionID: 's1' }, output);

    expect(output.context[0]).toContain('Task task-new (active):');
  });

  it('honours STATE3_ROOT over the plugin working directory', async () => {
    const other = await mkdtemp(join(tmpdir(), 'state3-root-'));
    await mkdir(join(other, '.state3'), { recursive: true });
    await writeFile(
      join(other, '.state3', 'task-9.json'),
      JSON.stringify({ ...makeRecord(), id: 'task-9' }),
    );
    process.env.STATE3_ROOT = other;

    const hooks = await loadHooks();
    const output = { context: [] };
    await hooks['experimental.session.compacting']({ sessionID: 's1' }, output);

    expect(output.context[0]).toContain('Task task-9 (active):');
    await rm(other, { recursive: true, force: true });
  });

  it('ignores unresolved and root-only directory values from opencode', async () => {
    const expected = `state: ${join(process.cwd(), '.state3')}`;

    for (const bogus of ['${project}', '   ', parse(process.cwd()).root]) {
      logs = [];
      await State3({
        directory: bogus,
        worktree: bogus,
        project: { id: 'global', worktree: bogus },
        client: client(),
      });

      expect(logs).toHaveLength(1);
      expect(logs[0].body.message).toContain(expected);
    }
  });

  it('prefers directory over the "/" worktree opencode reports for a non-git project', async () => {
    await writeTask(makeRecord());

    const hooks = await State3({
      directory: projectDir,
      worktree: '/',
      project: { id: 'global', worktree: '/' },
      client: client(),
    });
    const output = { context: [] };
    await hooks['experimental.session.compacting']({ sessionID: 's1' }, output);

    expect(logs[0].body.message).toContain(`state: ${join(projectDir, '.state3')}`);
    expect(output.context[0]).toContain('Task task-1 (active):');
  });

  it('prefers STATE3_STATE_DIR over the project directory', async () => {
    const other = await mkdtemp(join(tmpdir(), 'state3-state-'));
    await writeFile(join(other, 'task-7.json'), JSON.stringify({ ...makeRecord(), id: 'task-7' }));
    process.env.STATE3_STATE_DIR = other;

    const hooks = await loadHooks();
    const output = { context: [] };
    await hooks['experimental.session.compacting']({ sessionID: 's1' }, output);

    expect(output.context[0]).toContain('Task task-7 (active):');
    await rm(other, { recursive: true, force: true });
  });

  it('adds the size hint only when Σ grows past the threshold', async () => {
    await writeTask(makeRecord({ decisions: ['x'.repeat(4200)] }));
    const hooks = await loadHooks();
    const output = { context: [] };

    await hooks['experimental.session.compacting']({ sessionID: 's1' }, output);

    expect(output.context[0]).toContain('compress it');

    await writeTask(makeRecord());
    const small = { context: [] };
    await hooks['experimental.session.compacting']({ sessionID: 's1' }, small);
    expect(small.context[0]).not.toContain('compress it');
  });

  it('leaves the risk guard off by default', async () => {
    await writeTask(makeRecord({ next: { action: 'force-push', risk: 'destructive' } }));

    const hooks = await loadHooks();

    expect(hooks['tool.execute.before']).toBeUndefined();
  });

  it('blocks guarded tools while next.risk is destructive and allows the rest', async () => {
    await writeTask(makeRecord({ next: { action: 'force-push', risk: 'destructive' } }));
    process.env.STATE3_GUARD = '1';
    const hooks = await loadHooks();

    await expect(
      hooks['tool.execute.before']({ tool: 'bash', sessionID: 's', callID: 'c' }, { args: {} }),
    ).rejects.toThrow(/destructive/);
    await expect(
      hooks['tool.execute.before']({ tool: 'write', sessionID: 's', callID: 'c' }, { args: {} }),
    ).rejects.toThrow(/ask the user for confirmation/i);
    await expect(
      hooks['tool.execute.before']({ tool: 'read', sessionID: 's', callID: 'c' }, { args: {} }),
    ).resolves.toBeUndefined();
  });

  it('does not block anything when next.risk is safe', async () => {
    await writeTask(makeRecord());
    process.env.STATE3_GUARD = '1';
    const hooks = await loadHooks();

    await expect(
      hooks['tool.execute.before']({ tool: 'bash', sessionID: 's', callID: 'c' }, { args: {} }),
    ).resolves.toBeUndefined();
  });

  it('logs through the opencode client instead of throwing when logging fails', async () => {
    await writeTask(makeRecord());
    const hooks = await State3({
      directory: projectDir,
      worktree: projectDir,
      client: {
        app: {
          log: async () => {
            throw new Error('log backend down');
          },
        },
      },
    });
    const output = { context: [] };

    await hooks['experimental.session.compacting']({ sessionID: 's1' }, output);

    expect(output.context).toHaveLength(1);
    expect(logs).toEqual([]);
  });

  it('reports the loaded configuration through client.app.log', async () => {
    await writeTask(makeRecord());

    await loadHooks();

    expect(logs).toHaveLength(1);
    expect(logs[0].body.service).toBe('state3');
    expect(logs[0].body.message).toContain('loaded');
  });
});
