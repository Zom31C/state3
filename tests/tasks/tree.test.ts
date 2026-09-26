import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readInjection } from '../../src/tasks/inject.js';
import { devTaskSchema } from '../../src/tasks/schema.js';
import type { DevTaskState } from '../../src/tasks/schema.js';
import { TaskPatchError, TaskStore } from '../../src/tasks/store.js';
import type { StoredTask } from '../../src/tasks/store.js';

let dir: string;
let store: TaskStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'state3-tree-'));
  store = new TaskStore(dir);
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

const dev = (task: StoredTask): DevTaskState => devTaskSchema.parse(task.state);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** An element a test asked for by position, failing loudly instead of reading as undefined. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`expected an item at ${index} of ${items.length}`);
  return item;
}

const STEP_ONE = 'Migrate the schema';
const STEP_TWO = 'Rewrite the injection';
const STEP_THREE = 'Update the docs';
const STEPS = [STEP_ONE, STEP_TWO, STEP_THREE] as const;
const ROOT_GOAL = 'Ship the release';

/**
 * A root task split into three subtasks, in the order the work was decomposed in.
 *
 * No delay between them, deliberately: an agent splitting a job lands every piece inside one
 * millisecond, and the queue has to come out in the order the pieces were created anyway. That
 * is what the row's insertion order is for — with `created_at` alone this test would be decided
 * by the random suffix of an id.
 */
async function splitThreeStored(): Promise<{ root: StoredTask; subs: StoredTask[] }> {
  const root = await store.start(ROOT_GOAL);
  const subs: StoredTask[] = [];
  for (const step of STEPS) {
    subs.push(await store.start(step, { parent: root.meta.id }));
  }
  return { root, subs };
}

describe('splitting a task', () => {
  it('queues the subtask behind the work in flight and records whose it is', async () => {
    const { root, subs } = await splitThreeStored();

    expect(at(subs, 0).meta.parent).toBe(root.meta.id);
    expect(dev(at(subs, 0)).status).toBe('pending');
    expect(dev(root).status).toBe('active');
  });

  it('refuses a parent that was never a task', async () => {
    await expect(store.start('Orphan', { parent: 'task-nope' })).rejects.toThrow(TaskPatchError);
    await expect(store.start('Orphan', { parent: 'task-nope' })).rejects.toThrow(
      /no task with id "task-nope"/,
    );
  });

  it('refuses a parent that is finished', async () => {
    const root = await store.start('Done work');
    await store.finish('shipped', root.meta.id);

    await expect(store.start('More work', { parent: root.meta.id })).rejects.toThrow(
      /takes no new subtasks/,
    );
  });
});

describe('which task the tools act on', () => {
  it('hands over the first queued subtask, not the decomposition above it', async () => {
    const { root, subs } = await splitThreeStored();

    expect(await store.activeId()).toBe(at(subs, 0).meta.id);
    expect(await store.activeId()).not.toBe(root.meta.id);
  });

  it('prefers the subtask somebody is working on over the queue behind it', async () => {
    const { subs } = await splitThreeStored();
    await store.patch({ status: 'active' }, at(subs, 1).meta.id);

    expect(await store.activeId()).toBe(at(subs, 1).meta.id);
  });

  it('hands over a ready piece rather than a task that is blocked', async () => {
    const { subs } = await splitThreeStored();
    const stuck = await store.start('Stuck on a decision');
    await store.patch({ status: 'blocked', blockers: ['waiting on the user'] }, stuck.meta.id);

    // The blocker is the newest open task, so "most recently updated" picks it, and a rank of its
    // own is what stops one parked task from standing in front of the whole queue: the frontier
    // answers what can be worked on now, and a blocked task by definition cannot be.
    expect(await store.activeId()).toBe(at(subs, 0).meta.id);
  });

  it('still lands on a blocked task when nothing is ready to work on', async () => {
    const stuck = await store.start('Stuck on a decision');
    await store.patch({ status: 'blocked', blockers: ['waiting on the user'] }, stuck.meta.id);

    // Downranking a blocker must not hide it: with no queue to hand over it is still the work, and
    // an agent must be able to patch its way out without looking the id up first.
    expect(await store.activeId()).toBe(stuck.meta.id);
    const injection = readInjection(dir);
    expect(injection.kind).toBe('context');
    if (injection.kind !== 'context' || injection.task === null) return;
    expect(injection.task).toContain(`Task ${stuck.meta.id}`);
    expect(injection.task).toContain('waiting on the user');
  });

  it('comes back to the parent once every subtask is closed', async () => {
    const { root, subs } = await splitThreeStored();
    for (const sub of subs) await store.finish('piece done', sub.meta.id);

    expect(await store.activeId()).toBe(root.meta.id);
  });
});

describe('closing a decomposition', () => {
  it('refuses to finish a task while a subtask is still open', async () => {
    const { root, subs } = await splitThreeStored();

    await expect(store.patch({ status: 'done' }, root.meta.id)).rejects.toThrow(
      /3 open subtask\(s\)/,
    );
    await expect(store.finish('whole thing shipped', root.meta.id)).rejects.toThrow(
      /3 open subtask\(s\)/,
    );

    for (const sub of subs) await store.finish('piece done', sub.meta.id);
    expect(dev(await store.finish('whole thing shipped', root.meta.id)).status).toBe('done');
  });

  it('counts a subtask this runtime cannot read, so it cannot be closed over', async () => {
    const { root } = await splitThreeStored();
    // A row whose skill this runtime does not have: list() drops it from the summaries, but the
    // tree must still hold the parent open, or the work would hide behind a task it is legal to
    // close.
    store
      .database()
      .prepare('UPDATE task SET skill = ? WHERE goal = ?')
      .run('no-such-skill', STEP_ONE);

    const all = await store.list();
    expect(all).toHaveLength(3);
    expect(all.find((task) => task.id === root.meta.id)?.openSubtasks).toBe(3);
  });
});

describe('reading the tree', () => {
  it('reports the branch root-first and the subtree parents-first', async () => {
    const root = await store.start('top');
    const mid = await store.start('middle', { parent: root.meta.id });
    await delay(2);
    const leaf = await store.start('bottom', { parent: mid.meta.id });

    expect((await store.branchOf(leaf.meta.id)).map((task) => task.goal)).toEqual([
      'top',
      'middle',
      'bottom',
    ]);
    expect((await store.subtreeOf(root.meta.id)).map((task) => task.goal)).toEqual([
      'middle',
      'bottom',
    ]);
  });

  it('answers the queue behind one subtask, and nothing behind the last', async () => {
    const { subs } = await splitThreeStored();

    expect((await store.laterSiblingsOf(at(subs, 0).meta.id)).map((task) => task.goal)).toEqual([
      STEP_TWO,
      STEP_THREE,
    ]);
    expect(await store.laterSiblingsOf(at(subs, 2).meta.id)).toEqual([]);
  });

  it('lists a root task as a tree of one, with no children to report', async () => {
    const only = await store.start('A job nobody split');
    const summary = (await store.list()).find((task) => task.id === only.meta.id);

    expect(summary).toMatchObject({ parent: null, subtasks: 0, openSubtasks: 0 });
  });
});

describe('what a prompt carries', () => {
  it('names the branch and the next sibling, and leaves the rest of the queue out', async () => {
    const { subs } = await splitThreeStored();
    await store.patch({ status: 'active' }, at(subs, 0).meta.id);

    const injection = readInjection(dir);
    expect(injection.kind).toBe('context');
    if (injection.kind !== 'context' || injection.task === null) return;

    expect(injection.task).toContain(`Branch: ${ROOT_GOAL} [active] -> this task`);
    expect(injection.task).toContain(`Queued after this: "${STEP_TWO}"`);
    expect(injection.task).toContain('+ 1 more');
    // The whole point of splitting: the third piece of work is a count, not text in the prompt.
    expect(injection.task).not.toContain(STEP_THREE);
    // And the state carried is the one being worked on.
    expect(injection.task).toContain(STEP_ONE);
  });

  it('carries no branch lines for a task nobody split', async () => {
    await store.start('A job nobody split');

    const injection = readInjection(dir);
    expect(injection.kind).toBe('context');
    if (injection.kind !== 'context' || injection.task === null) return;
    expect(injection.task).not.toContain('Branch:');
    expect(injection.task).not.toContain('Queued after this');
  });

  it('tells a delegated subagent which piece it is on, but not what comes next', async () => {
    const { subs } = await splitThreeStored();
    await store.patch({ status: 'active' }, at(subs, 0).meta.id);

    const injection = readInjection(dir, { subagent: true });
    expect(injection.kind).toBe('context');
    if (injection.kind !== 'context' || injection.task === null) return;
    expect(injection.task).toContain(`Branch: ${ROOT_GOAL} [active] -> this task`);
    // It was handed one piece of work; naming the next one is an invitation to start it.
    expect(injection.task).not.toContain('Queued after this');
  });

  it('names queued work under another root at a session start, and not on every prompt', async () => {
    // The shape a cold session actually lands in: the frontier picks the unrelated active root,
    // because the decomposition's parent is a container and its pieces are only pending. Without
    // this line nothing in the prompt says the queue exists, and the session starts new work
    // beside it instead of resuming what was split.
    await splitThreeStored();
    const other = await store.start('Unrelated job in flight');

    const atStart = readInjection(dir, { drift: true });
    expect(atStart.kind).toBe('context');
    if (atStart.kind !== 'context' || atStart.task === null) return;
    expect(atStart.task).toContain(`Task ${other.meta.id}`);
    expect(atStart.task).toContain(
      'Also open elsewhere: 3 queued in 1 decomposition, 1 other open root',
    );
    // The task in flight is a root, so there is no branch and no queue of its own to report.
    expect(atStart.task).not.toContain('Queued after this');

    const onPrompt = readInjection(dir);
    expect(onPrompt.kind).toBe('context');
    if (onPrompt.kind !== 'context' || onPrompt.task === null) return;
    expect(onPrompt.task).not.toContain('Also open elsewhere');
  });

  it('stays quiet when the branch and the queue already cover every open task', async () => {
    const { subs } = await splitThreeStored();
    await store.patch({ status: 'active' }, at(subs, 0).meta.id);

    const atStart = readInjection(dir, { drift: true });
    expect(atStart.kind).toBe('context');
    if (atStart.kind !== 'context' || atStart.task === null) return;
    expect(atStart.task).toContain('Queued after this');
    // The parent is named by Branch and the two siblings by the queue line: counting them again
    // would only make the number harder to read.
    expect(atStart.task).not.toContain('Also open elsewhere');
  });
});
