import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StateDict } from '../../src/core/types.js';
import { inspectStateRoot } from '../../src/tasks/doctor.js';
import { readInjection } from '../../src/tasks/inject.js';
import { devTaskSchema } from '../../src/tasks/schema.js';
import type { DevTaskState } from '../../src/tasks/schema.js';
import { applyGuardedMove, TaskPatchError, TaskStore } from '../../src/tasks/store.js';
import type { FinishReport, PatchReport, StoredTask } from '../../src/tasks/store.js';

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

/**
 * A chain `depth` levels deep, each task split out of the one before it; returns the goals,
 * root first.
 *
 * The deepest task is the one a prompt carries without any help: every level above it has an open
 * subtask, so none of them is at the frontier, and the leaf is the only candidate.
 */
async function chainOf(depth: number): Promise<string[]> {
  const goals: string[] = [];
  let parent: string | undefined;
  for (let level = 0; level < depth; level++) {
    const goal = `Level ${level} of the chain`;
    const task = await store.start(goal, parent === undefined ? {} : { parent });
    goals.push(goal);
    parent = task.meta.id;
  }
  return goals;
}

/** The `Branch:` line of the next prompt injection, or a placeholder that fails an assertion. */
function injectedBranch(): string {
  const injection = readInjection(dir);
  if (injection.kind !== 'context' || injection.task === null) return '(no injection)';
  return injection.task.split('\n').find((line) => line.startsWith('Branch:')) ?? '(no branch)';
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

describe('re-parenting a task', () => {
  /** A root with one subtask that was itself split, plus an unrelated root to move it under. */
  async function twoDecompositions(): Promise<{
    first: StoredTask;
    piece: StoredTask;
    inner: StoredTask;
    second: StoredTask;
  }> {
    const first = await store.start('First decomposition');
    const piece = await store.start('A piece of it', { parent: first.meta.id });
    const inner = await store.start('Split out of that piece', { parent: piece.meta.id });
    const second = await store.start('Second decomposition');
    return { first, piece, inner, second };
  }

  /**
   * A root with one leaf subtask, plus an unrelated root to move it under.
   *
   * The moved task has no subtask of its own here on purpose: a task that has been split is a
   * container, and neither `activeId` nor the injection ever lands on one, so a test about "the
   * task is still the work in flight" has to move a leaf.
   */
  async function leafAndSomewhereToPutIt(): Promise<{
    root: StoredTask;
    leaf: StoredTask;
    elsewhere: StoredTask;
  }> {
    const root = await store.start('First decomposition');
    const leaf = await store.start('The piece in flight', { parent: root.meta.id });
    const elsewhere = await store.start('Second decomposition');
    return { root, leaf, elsewhere };
  }

  it('moves a task under another one, and its own subtasks come with it', async () => {
    const { piece, inner, second } = await twoDecompositions();

    const moved = await store.patch({ parent: second.meta.id }, piece.meta.id);

    expect(moved.meta.parent).toBe(second.meta.id);
    // One row changes, so what was split out of this piece stays split out of it: the subtree
    // hangs off the task, not off the branch the task happened to be filed under.
    expect((await store.branchOf(inner.meta.id)).map((task) => task.goal)).toEqual([
      'Second decomposition',
      'A piece of it',
      'Split out of that piece',
    ]);
  });

  it('makes a task a root again, which lets the decomposition it left be closed', async () => {
    const { first, piece } = await twoDecompositions();

    expect((await store.patch({ parent: null }, piece.meta.id)).meta.parent).toBeNull();
    expect((await store.list()).find((task) => task.id === first.meta.id)?.openSubtasks).toBe(0);
    expect(dev(await store.finish('nothing left under it', first.meta.id)).status).toBe('done');
  });

  it('keeps the status of the task it moves, so work in flight is not queued again', async () => {
    const { leaf, elsewhere } = await leafAndSomewhereToPutIt();
    await store.patch({ status: 'active' }, leaf.meta.id);

    const moved = await store.patch({ parent: elsewhere.meta.id }, leaf.meta.id);

    // Demoting it to "pending" — what a *new* subtask gets — would hand the frontier to a
    // sibling nobody mentioned, and the agent that moved the task would lose its own Σ.
    expect(dev(moved).status).toBe('active');
    expect(await store.activeId()).toBe(leaf.meta.id);
  });

  it('refuses a parent that was never a task, and leaves the tree as it was', async () => {
    const { piece, first } = await twoDecompositions();

    await expect(store.patch({ parent: 'task-nope' }, piece.meta.id)).rejects.toThrow(
      /no task with id "task-nope" to move this one under/,
    );
    await expect(store.patch({ parent: 'task-nope' }, piece.meta.id)).rejects.toThrow(
      TaskPatchError,
    );
    expect((await store.show(piece.meta.id)).meta.parent).toBe(first.meta.id);
  });

  it('refuses a parent that is finished', async () => {
    const { piece } = await twoDecompositions();
    const closed = await store.start('Work that is over');
    await store.finish('shipped', closed.meta.id);

    await expect(store.patch({ parent: closed.meta.id }, piece.meta.id)).rejects.toThrow(
      /takes no new subtasks/,
    );
  });

  it('refuses to file a task under itself', async () => {
    const { piece } = await twoDecompositions();

    await expect(store.patch({ parent: piece.meta.id }, piece.meta.id)).rejects.toThrow(
      /cannot be its own parent/,
    );
  });

  it('refuses a parent that already sits under this task', async () => {
    const { piece, inner } = await twoDecompositions();

    await expect(store.patch({ parent: inner.meta.id }, piece.meta.id)).rejects.toThrow(
      /would make it its own ancestor/,
    );
    expect((await store.show(piece.meta.id)).meta.parent).not.toBe(inner.meta.id);
  });

  it('refuses a value that is not an id, and says what the key takes', async () => {
    const { piece } = await twoDecompositions();

    await expect(store.patch({ parent: 42 }, piece.meta.id)).rejects.toThrow(
      /it takes a task id, or null to make it a root task — not a number/,
    );
  });

  it('refuses a finished descendant as a loop, not as a finished parent', async () => {
    const { piece, inner } = await twoDecompositions();
    await store.finish('done for now', inner.meta.id);

    // Both refusals are true of this move, but only one of them is any use: "move it under an
    // open task instead" cannot work for a descendant of this task, open or finished.
    await expect(store.patch({ parent: inner.meta.id }, piece.meta.id)).rejects.toThrow(
      /would make it its own ancestor/,
    );
  });

  it('reads a parent key with no value as no opinion, not as a detach', async () => {
    const { piece, first } = await twoDecompositions();
    // The shape an in-process caller produces by spreading an absent option; over JSON the key is
    // simply not there. Read as null, it would move a task nobody asked to move.
    const patch = { decisions: ['a note'], parent: undefined } as unknown as StateDict;

    const report: PatchReport = {};
    const after = await store.patch(patch, piece.meta.id, report);

    expect(after.meta.parent).toBe(first.meta.id);
    expect(report.moved).toBeUndefined();
    // The rest of the patch still applied, and the keyless field did not leak into Σ.
    expect(dev(after).decisions).toEqual(['a note']);
    expect(Object.keys(after.state)).not.toContain('parent');
  });

  it('reports the move and records where the task came from', async () => {
    const { first, piece, second } = await twoDecompositions();

    const report: PatchReport = {};
    await store.patch({ parent: second.meta.id }, piece.meta.id, report);

    // Σ cannot show it — the parent is a column, and the state renders the same either way — so
    // a move nobody is told about is a move that cannot be audited afterwards.
    expect(report.moved).toEqual({ from: first.meta.id, to: second.meta.id });
    const entries = await store.history(piece.meta.id);
    expect(entries.at(entries.length - 1)?.note).toContain(
      `moved from ${first.meta.id} under ${second.meta.id}`,
    );
  });

  it('reports nothing when the parent it was given is the one the task already had', async () => {
    const { first, piece } = await twoDecompositions();

    const report: PatchReport = {};
    await store.patch({ parent: first.meta.id }, piece.meta.id, report);

    expect(report.moved).toBeUndefined();
  });

  it('moves the branch the prompt carries with it', async () => {
    const { leaf, elsewhere } = await leafAndSomewhereToPutIt();
    // Active and just touched, so it stays the frontier after the move: the injection then has
    // to name the new branch, which is the only line in the prompt that says where this is.
    await store.patch({ status: 'active', parent: elsewhere.meta.id }, leaf.meta.id);

    const injection = readInjection(dir);
    expect(injection.kind).toBe('context');
    if (injection.kind !== 'context' || injection.task === null) return;
    expect(injection.task).toContain('Branch: Second decomposition [active] -> this task');
    expect(injection.task).not.toContain('First decomposition');
  });
});

describe('handing the queue over', () => {
  it('promotes the next piece in the queue and says which one it was', async () => {
    const { subs } = await splitThreeStored();

    const report: FinishReport = {};
    await store.finish('piece done', at(subs, 0).meta.id, report);

    expect(dev(await store.show(at(subs, 1).meta.id)).status).toBe('active');
    expect(report.handedOver).toEqual({ id: at(subs, 1).meta.id, goal: STEP_TWO });
    expect(await store.activeId()).toBe(at(subs, 1).meta.id);
  });

  it('hands over when a patch closes the task, not only when task_finish does', async () => {
    const { subs } = await splitThreeStored();

    const report: PatchReport = {};
    await store.patch({ status: 'done' }, at(subs, 0).meta.id, report);

    // The two are the same event; a mechanism only one of them has is a mechanism an agent has to
    // remember to use the other way round.
    expect(report.handedOver).toEqual({ id: at(subs, 1).meta.id, goal: STEP_TWO });
  });

  it('leaves a blocked piece blocked and promotes the one behind it', async () => {
    const { subs } = await splitThreeStored();
    await store.patch(
      { status: 'blocked', blockers: ['waiting on the user'] },
      at(subs, 1).meta.id,
    );

    const report: FinishReport = {};
    await store.finish('piece done', at(subs, 0).meta.id, report);

    // Promoting it would erase the signal that it is waiting on something, and the frontier
    // already ranks a ready piece above a blocked one, so the queue is not stuck behind it.
    expect(dev(await store.show(at(subs, 1).meta.id)).status).toBe('blocked');
    expect(report.handedOver).toEqual({ id: at(subs, 2).meta.id, goal: STEP_THREE });
  });

  it('promotes nothing while another piece of the same decomposition is in flight', async () => {
    const { subs } = await splitThreeStored();
    await store.patch({ status: 'active' }, at(subs, 2).meta.id);

    const report: FinishReport = {};
    await store.finish('piece done', at(subs, 0).meta.id, report);

    // Somebody took the third piece by hand; promoting the second as well would recreate exactly
    // the ambiguity the `pending` status exists to prevent.
    expect(report.handedOver).toBeUndefined();
    expect(dev(await store.show(at(subs, 1).meta.id)).status).toBe('pending');
  });

  it('hands back to the decomposition that was split, once its last piece closes', async () => {
    const root = await store.start('Outer job');
    const middle = await store.start('A decomposition inside it', { parent: root.meta.id });
    const only = await store.start('The single piece', { parent: middle.meta.id });

    const report: FinishReport = {};
    await store.finish('piece done', only.meta.id, report);

    // The nested level was created `pending` like any subtask, and it is the frontier now that
    // nothing under it is open — leaving it queued is the same lie `task_list` used to tell.
    expect(report.handedOver).toEqual({ id: middle.meta.id, goal: 'A decomposition inside it' });
    expect(await store.activeId()).toBe(middle.meta.id);
    // The outer job is a container with an open subtask, so it is not the frontier.
    expect(dev(await store.show(root.meta.id)).status).toBe('active');
  });

  it('hands nothing over when the task it closed had no queue', async () => {
    const only = await store.start('A job nobody split');

    const report: FinishReport = {};
    await store.finish('shipped', only.meta.id, report);

    expect(report.handedOver).toBeUndefined();
  });

  it('records the promotion in the history of the task it promoted', async () => {
    const { subs } = await splitThreeStored();

    await store.finish('piece done', at(subs, 0).meta.id);

    // Nobody sent that patch, so without the note an audit of "why is this active" comes up empty.
    const entries = await store.history(at(subs, 1).meta.id);
    expect(entries.at(-1)?.note).toContain('promoted by the runtime');
    expect(entries.at(-1)?.note).toContain(at(subs, 0).meta.id);
  });

  it('skips a successor this runtime cannot read and hands over to the one behind it', async () => {
    const { root, subs } = await splitThreeStored();
    store
      .database()
      .prepare('UPDATE task SET skill = ? WHERE goal = ?')
      .run('no-such-skill', STEP_TWO);

    const report: FinishReport = {};
    const closed = await store.finish('piece done', at(subs, 0).meta.id, report);

    // A state this build cannot validate is a reason to leave that row's status alone — not a
    // reason to fail the close, and not a reason to leave the queue looking unattended: the
    // frontier skips the unreadable piece too, so the readable one behind it is the work.
    expect(dev(closed).status).toBe('done');
    expect(report.handedOver).toEqual({ id: at(subs, 2).meta.id, goal: STEP_THREE });
    expect((await store.list()).find((task) => task.id === root.meta.id)?.openSubtasks).toBe(2);
  });
});

describe('a status that means a place in a queue', () => {
  it('refuses to queue a root task, and says what to do instead', async () => {
    const root = await store.start('A job nobody split');

    await expect(store.patch({ status: 'pending' }, root.meta.id)).rejects.toThrow(
      /a root task cannot be "pending"/,
    );
    await expect(store.patch({ status: 'pending' }, root.meta.id)).rejects.toThrow(TaskPatchError);
    // Nothing queues a root, so nothing would ever hand it over — and the frontier ranks a queued
    // task as ready work, which is a lie about a task nobody is waiting to give out.
    expect(dev(await store.show(root.meta.id)).status).toBe('active');
  });

  it('takes a detached piece out of the queue instead of leaving it queued', async () => {
    const first = await store.start('First decomposition');
    const piece = await store.start('A piece of it', { parent: first.meta.id });
    expect(dev(piece).status).toBe('pending');

    const detached = await store.patch({ parent: null }, piece.meta.id);

    expect(detached.meta.parent).toBeNull();
    expect(dev(detached).status).toBe('active');
    // The patch as sent says nothing about a status, so the note is the only place it is recorded.
    const entries = await store.history(piece.meta.id);
    expect(entries.at(-1)?.note).toContain('its status became "active"');
  });

  it('still lets a root task be blocked, which is the status that means waiting', async () => {
    const root = await store.start('A job nobody split');

    const blocked = await store.patch(
      { status: 'blocked', blockers: ['waiting on the user'] },
      root.meta.id,
    );

    expect(dev(blocked).status).toBe('blocked');
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

  it('reads a chain four levels deep in full, so the cap costs an ordinary tree nothing', async () => {
    await chainOf(4);

    expect(injectedBranch()).toBe(
      'Branch: Level 0 of the chain [active] -> Level 1 of the chain [pending] -> ' +
        'Level 2 of the chain [pending] -> this task',
    );
  });

  it('names the root and the two nearest levels of a deep chain, and counts what it left out', async () => {
    // Depth is the axis that grows without bound, and the branch line rides on every prompt: on a
    // chain of 15 levels with sentence-long goals it ran to 1752 chars, 84% of everything the
    // injection carried. What a reader needs is the two ends — which job this is a piece of, and
    // which piece — so the middle becomes a count, like the queue behind it.
    await chainOf(6);

    const line = injectedBranch();
    expect(line).toBe(
      'Branch: Level 0 of the chain [active] -> … 2 more -> Level 3 of the chain [pending] -> ' +
        'Level 4 of the chain [pending] -> this task',
    );
    expect(line).not.toContain('Level 1 of the chain');
    expect(line).not.toContain('Level 2 of the chain');
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

  it('tells a session to take the queued piece the frontier handed it, and stops once taken', async () => {
    // The shape a cold session lands in after a split: nothing promotes a piece when a
    // decomposition is made, so the frontier carries a task still marked "pending" under a header
    // that calls it the active state. Without this line the session reads it as somebody else's
    // work and spends its first calls on task_list and task_show to find out what to do.
    const { subs } = await splitThreeStored();

    const injection = readInjection(dir);
    expect(injection.kind).toBe('context');
    if (injection.kind !== 'context' || injection.task === null) return;
    expect(injection.task).toContain(`Task ${at(subs, 0).meta.id}`);
    expect(injection.task.split('\n')[0]).toBe(
      'Queued, not yet taken: this piece is at the frontier but still "pending" — take it by ' +
        'sending {"status":"active"} with your first patch.',
    );

    await store.patch({ status: 'active' }, at(subs, 0).meta.id);
    const taken = readInjection(dir);
    if (taken.kind !== 'context' || taken.task === null) return;
    expect(taken.task).not.toContain('Queued, not yet taken');
  });

  it('leaves a delegated subagent without the takeover line: Σ is not its to claim', async () => {
    await splitThreeStored();

    const injection = readInjection(dir, { subagent: true });
    expect(injection.kind).toBe('context');
    if (injection.kind !== 'context' || injection.task === null) return;
    expect(injection.task).not.toContain('Queued, not yet taken');
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

/**
 * The guard inside the write transaction, against the tree another writer left behind.
 *
 * Two processes cannot be interleaved inside one synchronous `patch()` call, so what is staged
 * here is the second half of the race: a move validated against a tree that has since changed, and
 * the statement that performs it having to notice.
 */
describe('applyGuardedMove', () => {
  it('refuses the move that would close a loop and leaves the tree as the other writer left it', async () => {
    const { subs } = await splitThreeStored();
    const first = at(subs, 0).meta.id;
    const second = at(subs, 1).meta.id;
    // The other writer filed the first piece under the second one; moving the second under the
    // first is what this writer had validated before that landed.
    await store.patch({ parent: second }, first);

    expect(applyGuardedMove(store.database(), first, second)).toBe(false);

    const report = await inspectStateRoot(dir);
    expect(report.parentCycles).toEqual([]);
    expect(report.orphanedTasks).toEqual([]);
  });

  it('applies a move the tree still allows', async () => {
    const { subs } = await splitThreeStored();
    const second = at(subs, 1).meta.id;
    const third = at(subs, 2).meta.id;

    expect(applyGuardedMove(store.database(), second, third)).toBe(true);

    const list = await store.list();
    expect(list.find((task) => task.id === third)?.parent).toBe(second);
  });

  it('refuses a parent that was closed while the move was being validated', async () => {
    const { subs } = await splitThreeStored();
    const first = at(subs, 0).meta.id;
    const second = at(subs, 1).meta.id;
    await store.finish('piece done', first);

    expect(applyGuardedMove(store.database(), first, second)).toBe(false);
  });

  it('refuses a parent that is not in the root at all', async () => {
    const { subs } = await splitThreeStored();

    expect(applyGuardedMove(store.database(), 'task-nope', at(subs, 0).meta.id)).toBe(false);
  });

  it('answers instead of recursing forever when the tree already holds a loop', async () => {
    const { subs } = await splitThreeStored();
    const first = at(subs, 0).meta.id;
    const second = at(subs, 1).meta.id;
    // Corrupt rows of the kind `doctor` reports: a task filed under itself.
    store.database().prepare('UPDATE task SET parent = id WHERE id = ?').run(first);

    expect(applyGuardedMove(store.database(), first, second)).toBe(true);
  });
});
