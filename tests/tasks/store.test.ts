import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REJECT_CATEGORIES } from '../../src/core/rejections.js';
import type { RejectCategory } from '../../src/core/rejections.js';
import type { StateDict } from '../../src/core/types.js';
import { devTaskSchema } from '../../src/tasks/schema.js';
import type { DevTaskState } from '../../src/tasks/schema.js';
import { superviseTaskSchema } from '../../src/tasks/supervise.js';
import type { SuperviseTaskState } from '../../src/tasks/supervise.js';
import { TaskNotFoundError, TaskPatchError, TaskStore } from '../../src/tasks/store.js';
import type { StoredTask } from '../../src/tasks/store.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir: string;
let store: TaskStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'skillstate-'));
  store = new TaskStore(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** StoredTask.state is domain-neutral; tests read it through the schema of its skill. */
function dev(task: StoredTask): DevTaskState {
  return devTaskSchema.parse(task.state);
}

function supervised(task: StoredTask): SuperviseTaskState {
  return superviseTaskSchema.parse(task.state);
}

/** A record as written before skills and notation existed: neither field is present. */
function legacyRecord(id: string, extra: StateDict = {}): string {
  return JSON.stringify({
    id,
    createdAt: '2026-09-07T18:30:59.046Z',
    updatedAt: '2026-09-07T22:13:55.832Z',
    state: {
      goal: 'Task from an older runtime',
      status: 'active',
      plan: [{ id: '1', task: 'step one', status: 'in_progress', notes: '' }],
      artifacts: {},
      verifications: [],
      decisions: [],
      blockers: [],
      next: { action: 'continue', risk: 'safe' },
    },
    ...extra,
  });
}

describe('TaskStore.start', () => {
  it('creates a file and returns a valid state', async () => {
    const task = await store.start('Build the feature');
    expect(task.meta.id).toMatch(/^task-/);
    expect(task.state.goal).toBe('Build the feature');
    expect(task.state.status).toBe('active');
    expect(devTaskSchema.safeParse(task.state).success).toBe(true);

    const raw = await readFile(task.meta.path, 'utf-8');
    const record = JSON.parse(raw) as { id: string; skill: string; state: unknown };
    expect(record.id).toBe(task.meta.id);
    expect(record.skill).toBe('dev-task');
    expect(devTaskSchema.safeParse(record.state).success).toBe(true);
  });

  it("creates plan items with sequential ids and 'pending' status", async () => {
    const task = await store.start('Refactor', {
      plan: ['Extract helper', 'Write tests', 'Update docs'],
    });
    const plan = dev(task).plan;
    expect(plan).toHaveLength(3);
    expect(plan.map((p) => p.id)).toEqual(['1', '2', '3']);
    expect(plan.every((p) => p.status === 'pending')).toBe(true);
    expect(plan[0]?.task).toBe('Extract helper');
  });

  it('rejects an unknown skill and names the ones it has', async () => {
    await expect(store.start('Nope', { skill: 'alien' })).rejects.toThrow(
      /unknown skill "alien".*dev-task, supervise-task/,
    );
  });

  it('rejects a plan for a skill whose state has no plan array', async () => {
    await expect(
      store.start('Supervise', { skill: 'supervise-task', plan: ['step'] }),
    ).rejects.toThrow(/takes no plan/);
  });
});

describe('TaskStore.show', () => {
  it('returns the saved task by id', async () => {
    const created = await store.start('Task A');
    const shown = await store.show(created.meta.id);
    expect(shown.meta.id).toBe(created.meta.id);
    expect(shown.state.goal).toBe('Task A');
  });

  it('returns the active task when no id is given', async () => {
    await store.start('Task A');
    const shown = await store.show();
    expect(shown.state.goal).toBe('Task A');
  });

  it('throws TaskNotFoundError when no tasks exist', async () => {
    await expect(store.show()).rejects.toThrow(TaskNotFoundError);
    await expect(store.show()).rejects.toThrow('No active task found');
  });

  it('throws TaskNotFoundError for an unknown id', async () => {
    await expect(store.show('task-nonexistent-xxxx')).rejects.toThrow(TaskNotFoundError);
  });
});

describe('TaskStore.patch', () => {
  it('merges nested artifacts and replaces the plan array wholesale', async () => {
    const task = await store.start('Merge test');
    await store.patch({ artifacts: { 'a.ts': 'first file' } }, task.meta.id);
    const patched = await store.patch(
      {
        artifacts: { 'b.ts': 'second file' },
        plan: [
          { id: '1', task: 'step one', status: 'in_progress', notes: '' },
          { id: '2', task: 'step two', status: 'pending', notes: '' },
        ],
      },
      task.meta.id,
    );

    expect(patched.state.artifacts).toEqual({ 'a.ts': 'first file', 'b.ts': 'second file' });
    expect(dev(patched).plan).toHaveLength(2);
    expect(dev(patched).plan[1]?.task).toBe('step two');
  });

  it('deletes an artifact key when patched with null', async () => {
    const task = await store.start('Delete test');
    await store.patch({ artifacts: { 'old.ts': 'to remove', 'keep.ts': 'stays' } }, task.meta.id);
    const patched = await store.patch({ artifacts: { 'old.ts': null } }, task.meta.id);
    expect(patched.state.artifacts).toEqual({ 'keep.ts': 'stays' });
    expect('old.ts' in (patched.state.artifacts as object)).toBe(false);
  });

  it('throws TaskPatchError with category unknown-key and leaves the file unchanged', async () => {
    const task = await store.start('Invalid patch');
    const before = await readFile(task.meta.path, 'utf-8');

    await expect(store.patch({ bogus: 'nope' }, task.meta.id)).rejects.toThrow(TaskPatchError);
    try {
      await store.patch({ bogus: 'nope' }, task.meta.id);
    } catch (e) {
      expect(e).toBeInstanceOf(TaskPatchError);
      expect((e as TaskPatchError).category).toBe('unknown-key');
    }

    const after = await readFile(task.meta.path, 'utf-8');
    expect(after).toBe(before);
  });

  it('throws TaskPatchError with category guard and records ok:false in history', async () => {
    const task = await store.start('Guard test');
    await store.finish('all done', task.meta.id);

    await expect(store.patch({ status: 'active' }, task.meta.id)).rejects.toThrow(TaskPatchError);
    try {
      await store.patch({ status: 'active' }, task.meta.id);
    } catch (e) {
      expect((e as TaskPatchError).category).toBe('guard');
    }

    const hist = await store.history(task.meta.id);
    const failed = hist.filter((h) => !h.ok);
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(failed[0]?.error?.category).toBe('guard');
  });

  it('updates updatedAt and writes an ok:true history entry on success', async () => {
    const task = await store.start('History test');
    const firstUpdatedAt = task.meta.updatedAt;
    await delay(15);

    const patched = await store.patch({ decisions: ['picked approach A'] }, task.meta.id);
    expect(patched.meta.updatedAt > firstUpdatedAt).toBe(true);
    expect(patched.state.decisions).toContain('picked approach A');

    const hist = await store.history(task.meta.id);
    expect(hist.length).toBeGreaterThanOrEqual(1);
    const okEntries = hist.filter((h) => h.ok);
    expect(okEntries.length).toBeGreaterThanOrEqual(1);
    expect(okEntries[okEntries.length - 1]?.patch).toEqual({ decisions: ['picked approach A'] });
  });
});

describe('TaskStore.patch with path keys', () => {
  it('changes one plan item and records the compact patch as sent', async () => {
    const task = await store.start('Path test', { plan: ['one', 'two'] });
    const patched = await store.patch({ 'plan[1].status': 'in_progress' }, task.meta.id);

    expect(dev(patched).plan[1]?.status).toBe('in_progress');
    expect(dev(patched).plan[0]?.status).toBe('pending');
    expect(dev(patched).plan[1]?.task).toBe('two');

    const hist = await store.history(task.meta.id);
    expect(hist[0]?.patch).toEqual({ 'plan[1].status': 'in_progress' });
  });

  it('appends an item with [+]', async () => {
    const task = await store.start('Append test', { plan: ['one'] });
    const patched = await store.patch(
      { 'plan[+]': { id: '2', task: 'two', status: 'pending', notes: '' } },
      task.meta.id,
    );
    expect(dev(patched).plan.map((p) => p.task)).toEqual(['one', 'two']);
  });

  it('runs the guard on the expanded patch, so a path cannot bypass a domain rule', async () => {
    const task = await store.start('Guard path test', { plan: ['one'] });
    await store.patch({ 'plan[0].status': 'done' }, task.meta.id);

    await expect(store.patch({ 'plan[0].status': 'pending' }, task.meta.id)).rejects.toThrow(
      TaskPatchError,
    );
    try {
      await store.patch({ 'plan[0].status': 'pending' }, task.meta.id);
    } catch (e) {
      expect((e as TaskPatchError).category).toBe('guard');
      expect((e as TaskPatchError).message).toContain('add an explanation in notes');
    }

    const withNotes = await store.patch(
      { 'plan[0].status': 'pending', 'plan[0].notes': 'reopened: the fix regressed' },
      task.meta.id,
    );
    expect(dev(withNotes).plan[0]?.status).toBe('pending');
  });

  it('rejects a bad path with category path and leaves the state untouched', async () => {
    const task = await store.start('Bad path', { plan: ['one'] });
    const before = await readFile(task.meta.path, 'utf-8');

    await expect(store.patch({ 'plan[7].status': 'done' }, task.meta.id)).rejects.toThrow(
      TaskPatchError,
    );
    try {
      await store.patch({ 'plan[7].status': 'done' }, task.meta.id);
    } catch (e) {
      expect((e as TaskPatchError).category).toBe('path');
      expect((e as TaskPatchError).message).toContain('out of range');
    }
    await expect(store.patch({ 'goal[0]': 'x' }, task.meta.id)).rejects.toThrow(/array field/);

    const after = await readFile(task.meta.path, 'utf-8');
    expect(after).toBe(before);

    const hist = await store.history(task.meta.id);
    expect(hist.every((h) => !h.ok)).toBe(true);
    expect(hist[0]?.error?.category).toBe('path');
  });

  it('rejects a field sent both wholesale and by path', async () => {
    const task = await store.start('Mixed patch', { plan: ['one'] });
    await expect(store.patch({ plan: [], 'plan[0].status': 'done' }, task.meta.id)).rejects.toThrow(
      /both wholesale and by path/,
    );
  });
});

describe('TaskStore.finish', () => {
  it('sets status done and records the summary exactly once', async () => {
    const task = await store.start('Finish test');
    const finished = await store.finish('Shipped the feature', task.meta.id);
    expect(finished.state.status).toBe('done');
    expect(dev(finished).next.risk).toBe('safe');
    expect(finished.state.decisions).toContain('Shipped the feature');
    expect(JSON.stringify(finished.state).split('Shipped the feature')).toHaveLength(2);
  });

  it('throws TaskNotFoundError on a second finish without id (no active task)', async () => {
    await store.start('Double finish');
    await store.finish('done once');
    await expect(store.finish('done twice')).rejects.toThrow(TaskNotFoundError);
    await expect(store.finish('done twice')).rejects.toThrow('No active task found');
  });

  it('closes a task of any skill through the shared status/decisions/next contract', async () => {
    const task = await store.start('Supervise finish', { skill: 'supervise-task' });
    const finished = await store.finish('worker shipped it', task.meta.id);

    expect(finished.state.status).toBe('done');
    expect(supervised(finished).decisions).toEqual(['worker shipped it']);
    expect(JSON.stringify(finished.state).split('worker shipped it')).toHaveLength(2);
    expect(superviseTaskSchema.safeParse(finished.state).success).toBe(true);
  });
});

describe('skills', () => {
  it('creates a supervise task with its own Σ, which the dev schema rejects', async () => {
    const task = await store.start('Review the worker', { skill: 'supervise-task' });

    expect(task.meta.skill).toBe('supervise-task');
    expect(task.state.rounds).toEqual([]);
    expect(superviseTaskSchema.safeParse(task.state).success).toBe(true);
    expect(devTaskSchema.safeParse(task.state).success).toBe(false);

    const raw = JSON.parse(await readFile(task.meta.path, 'utf-8')) as { skill: string };
    expect(raw.skill).toBe('supervise-task');
  });

  it('validates each task against its own skill and guard', async () => {
    const task = await store.start('Guarded supervision', { skill: 'supervise-task' });
    const round = {
      id: '1',
      assignment: 'implement car.gd',
      verdict: 'pending',
      evidence: '',
      feedback: '',
    };

    await store.patch({ rounds: [round] }, task.meta.id);
    await expect(store.patch({ 'rounds[0].verdict': 'accepted' }, task.meta.id)).rejects.toThrow(
      /cannot be accepted without evidence/,
    );
    await expect(store.patch({ 'rounds[0].verdict': 'rejected' }, task.meta.id)).rejects.toThrow(
      /cannot be rejected without feedback/,
    );

    const accepted = await store.patch(
      {
        'rounds[0].verdict': 'accepted',
        'rounds[0].evidence': 'read car.gd; godot --headless --check-only passed',
      },
      task.meta.id,
    );
    expect(supervised(accepted).rounds[0]?.verdict).toBe('accepted');

    // A dev-task patch shape is an unknown key here.
    await expect(store.patch({ plan: [] }, task.meta.id)).rejects.toThrow(TaskPatchError);
  });

  it('allows only one pending round at a time', async () => {
    const task = await store.start('Serial supervision', { skill: 'supervise-task' });
    await store.patch(
      {
        rounds: [{ id: '1', assignment: 'first', verdict: 'pending', evidence: '', feedback: '' }],
      },
      task.meta.id,
    );
    await expect(
      store.patch(
        {
          'rounds[+]': {
            id: '2',
            assignment: 'second',
            verdict: 'pending',
            evidence: '',
            feedback: '',
          },
        },
        task.meta.id,
      ),
    ).rejects.toThrow(/one round at a time/);
  });

  it('keeps skills in one root and reports progress per skill', async () => {
    const devTask = await store.start('Dev task', { plan: ['a', 'b'] });
    await delay(15);
    const superviseTask = await store.start('Supervise task', { skill: 'supervise-task' });
    await delay(15);
    await store.patch({ 'plan[0].status': 'done' }, devTask.meta.id);

    const all = await store.list();
    expect(all).toHaveLength(2);
    const byId = new Map(all.map((row) => [row.id, row]));
    expect(byId.get(devTask.meta.id)?.skill).toBe('dev-task');
    expect(byId.get(devTask.meta.id)?.progressDone).toBe(1);
    expect(byId.get(devTask.meta.id)?.progressTotal).toBe(2);
    expect(byId.get(superviseTask.meta.id)?.skill).toBe('supervise-task');
    expect(byId.get(superviseTask.meta.id)?.progressTotal).toBe(0);
  });

  it('returns the procedure of the task skill, plus the notation appendix', async () => {
    const plain = await store.start('Plain task');
    const compact = await store.start('Compact task', { notation: 'compact' });
    const review = await store.start('Supervised', { skill: 'supervise-task' });

    expect(store.instructionsFor(plain)).toContain('software engineering agent');
    expect(store.instructionsFor(plain)).not.toContain('## Notation: compact');
    expect(store.instructionsFor(compact)).toContain('## Notation: compact');
    expect(store.instructionsFor(compact)).toContain('compressed pseudocode');
    expect(store.instructionsFor(review)).toContain('supervising');
    expect(store.instructionsFor(review)).not.toContain('software engineering agent');
    expect(store.skillNames()).toEqual(['dev-task', 'supervise-task']);
  });
});

describe('notation', () => {
  it('persists the notation, defaults to plain, and survives patches', async () => {
    const compact = await store.start('Compact task', { notation: 'compact' });
    expect(compact.meta.notation).toBe('compact');
    expect(
      (JSON.parse(await readFile(compact.meta.path, 'utf-8')) as { notation: string }).notation,
    ).toBe('compact');

    const patched = await store.patch({ decisions: ['ctx tight -> compact'] }, compact.meta.id);
    expect(patched.meta.notation).toBe('compact');

    const plain = await store.start('Plain task');
    expect(plain.meta.notation).toBe('plain');
  });

  it('rejects an unknown notation under its own category, not the skill one', async () => {
    await expect(store.start('Bad notation', { notation: 'haiku' as 'compact' })).rejects.toThrow(
      /unknown notation "haiku".*plain, compact/,
    );
    try {
      await store.start('Bad notation', { notation: 'haiku' as 'compact' });
    } catch (e) {
      expect((e as TaskPatchError).category).toBe('notation');
    }
  });
});

/* The categories are published in three places at once — the vocabulary array,
 * the procedure P and the MCP hint table — so each one has to be reachable from
 * a real write, not just declared. */
describe('the rejection vocabulary', () => {
  it('rejects a write with every category it publishes', async () => {
    const seen = new Set<RejectCategory>();

    /** Runs a write that must fail, and pins the category it failed with. */
    const attempt = async (run: () => Promise<unknown>, category: RejectCategory) => {
      try {
        await run();
        expect.unreachable(`expected the store to reject with "${category}"`);
      } catch (error) {
        expect(error, `expected a "${category}" rejection`).toBeInstanceOf(TaskPatchError);
        expect((error as TaskPatchError).category).toBe(category);
        seen.add(category);
      }
    };

    const task = await store.start('Build the feature', { plan: ['step one'] });
    const id = task.meta.id;

    await attempt(() => store.patch({ bogus: 1 }, id), 'unknown-key');
    // An enum field reports a wrong value as a schema issue, so type-coercion
    // has to be provoked on a field whose schema is not an enum.
    await attempt(() => store.patch({ goal: 1 }, id), 'type-coercion');
    await attempt(() => store.patch({ status: 'risky' }, id), 'schema');
    await attempt(() => store.patch({ 'plan[5].status': 'done' }, id), 'path');
    await attempt(() => store.start('No such skill', { skill: 'garden-task' }), 'skill');
    await attempt(
      () => store.start('No such notation', { notation: 'haiku' as 'compact' }),
      'notation',
    );

    // The guard only fires on a transition, so this one needs a finished task.
    await store.finish('all done', id);
    await attempt(() => store.patch({ status: 'active' }, id), 'guard');

    expect([...seen].sort()).toEqual([...REJECT_CATEGORIES].sort());
  });
});

describe('records written before skills existed', () => {
  it('reads them as the default skill in plain notation', async () => {
    await writeFile(path.join(dir, 'task-legacy-0001.json'), legacyRecord('task-legacy-0001'));

    const shown = await store.show('task-legacy-0001');
    expect(shown.meta.skill).toBe('dev-task');
    expect(shown.meta.notation).toBe('plain');
    expect(dev(shown).plan[0]?.status).toBe('in_progress');
  });

  it('normalizes skill and notation onto the record at the next patch', async () => {
    await writeFile(path.join(dir, 'task-legacy-0002.json'), legacyRecord('task-legacy-0002'));

    await store.patch({ decisions: ['resumed from an older runtime'] }, 'task-legacy-0002');
    const raw = JSON.parse(await readFile(path.join(dir, 'task-legacy-0002.json'), 'utf-8')) as {
      skill: string;
      notation: string;
    };
    expect(raw.skill).toBe('dev-task');
    expect(raw.notation).toBe('plain');
  });

  it('lists a legacy record next to new ones and treats it as active', async () => {
    await writeFile(path.join(dir, 'task-legacy-0003.json'), legacyRecord('task-legacy-0003'));
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.skill).toBe('dev-task');
    expect(all[0]?.progressDone).toBe(0);
    expect(all[0]?.progressTotal).toBe(1);
    expect(await store.activeId()).toBe('task-legacy-0003');
  });

  it('refuses a record naming a skill this runtime does not have, and skips it in list', async () => {
    await writeFile(
      path.join(dir, 'task-alien-0001.json'),
      legacyRecord('task-alien-0001', { skill: 'alien-task' }),
    );

    await expect(store.show('task-alien-0001')).rejects.toThrow(/does not have/);
    expect(await store.list()).toHaveLength(0);
  });
});

describe('TaskStore.list', () => {
  it('returns tasks sorted by updatedAt desc with progress counters', async () => {
    const a = await store.start('Task A', { plan: ['step 1', 'step 2'] });
    await delay(15);
    await store.start('Task B');
    await delay(15);
    await store.patch(
      { plan: [{ id: '1', task: 'step 1', status: 'done', notes: '' }] },
      a.meta.id,
    );

    const all = await store.list();
    expect(all.length).toBe(2);
    // Task A was patched last → newest updatedAt
    expect(all[0]?.id).toBe(a.meta.id);
    expect(all[0]?.progressDone).toBe(1);
    expect(all[0]?.progressTotal).toBe(1);
    expect(all[1]?.goal).toBe('Task B');
    expect(all[0]!.updatedAt >= all[1]!.updatedAt).toBe(true);
  });

  it('skips corrupted files without throwing', async () => {
    await store.start('Good task');
    await writeFile(path.join(dir, 'task-broken-xxxx.json'), '{ not valid json', 'utf-8');

    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.goal).toBe('Good task');
  });
});

describe('TaskStore.history', () => {
  it('returns the latest entries and respects the limit', async () => {
    const task = await store.start('Limit test');
    for (let i = 0; i < 5; i++) {
      await store.patch({ decisions: [`decision ${i}`] }, task.meta.id);
    }

    const all = await store.history(task.meta.id);
    expect(all).toHaveLength(5);
    // oldest → newest
    expect(all[0]?.patch).toEqual({ decisions: ['decision 0'] });
    expect(all[4]?.patch).toEqual({ decisions: ['decision 4'] });

    const limited = await store.history(task.meta.id, 2);
    expect(limited).toHaveLength(2);
    expect(limited[0]?.patch).toEqual({ decisions: ['decision 3'] });
    expect(limited[1]?.patch).toEqual({ decisions: ['decision 4'] });
  });

  it('returns an empty array when no patches have been applied', async () => {
    const task = await store.start('No history');
    expect(await store.history(task.meta.id)).toEqual([]);
  });
});

describe('TaskStore atomicity and id generation', () => {
  it('leaves no .tmp files after several patches', async () => {
    const task = await store.start('Atomic test');
    await store.patch({ decisions: ['one'] }, task.meta.id);
    await store.patch({ decisions: ['one', 'two'] }, task.meta.id);
    await store.patch({ decisions: ['one', 'two', 'three'] }, task.meta.id);

    const files = await readdir(dir);
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('creates distinct ids and show() returns the newest active task', async () => {
    const a = await store.start('Task A');
    await delay(15);
    const b = await store.start('Task B');
    expect(a.meta.id).not.toBe(b.meta.id);

    // B is newer, so show() returns B
    const shown1 = await store.show();
    expect(shown1.meta.id).toBe(b.meta.id);

    // Patch A so it becomes the newest active task
    await delay(15);
    await store.patch({ decisions: ['A updated'] }, a.meta.id);
    const shown2 = await store.show();
    expect(shown2.meta.id).toBe(a.meta.id);
  });
});

describe('TaskStore.activeId', () => {
  it('returns null when no tasks exist', async () => {
    expect(await store.activeId()).toBeNull();
  });

  it('returns the most recently updated active task id', async () => {
    const a = await store.start('Task A');
    await delay(15);
    await store.start('Task B');
    await delay(15);
    await store.patch({ decisions: ['A touched'] }, a.meta.id);
    expect(await store.activeId()).toBe(a.meta.id);
  });

  it('skips done tasks', async () => {
    const a = await store.start('Task A');
    await store.finish('done', a.meta.id);
    expect(await store.activeId()).toBeNull();
  });

  it('falls back to a blocked task, so it can still be patched without an id', async () => {
    const a = await store.start('Task A');
    await store.patch({ status: 'blocked', blockers: ['waiting on the user'] }, a.meta.id);

    expect(await store.activeId()).toBe(a.meta.id);
    expect((await store.show()).meta.id).toBe(a.meta.id);

    const resumed = await store.patch({ status: 'active', blockers: [] });
    expect(resumed.state.status).toBe('active');
  });

  it('prefers an active task over a blocked one', async () => {
    const blocked = await store.start('Blocked');
    await store.patch({ status: 'blocked', blockers: ['waiting'] }, blocked.meta.id);
    await delay(15);
    const active = await store.start('Active');

    expect(await store.activeId()).toBe(active.meta.id);
  });
});
