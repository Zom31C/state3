import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { StateDict } from '../../src/core/types.js';
import { BRANCH_SEGMENT_CHARS, QUEUE_GOAL_CHARS, readInjection } from '../../src/tasks/inject.js';
import { TaskStore } from '../../src/tasks/store.js';

const PIECES = ['Migrate the schema', 'Rewrite the injection', 'Update the docs'] as const;

/**
 * How much state one piece of work has accumulated by the time it is done.
 *
 * The same content goes into both sides of the comparison; the only difference is how much of it a
 * prompt carries while the *first* piece is in flight.
 */
function workOf(index: number): { notes: string; decisions: string[]; verifications: StateDict[] } {
  return {
    notes:
      `Read ${index} modules and found ${index + 2} places to change; the first approach failed on ` +
      'initialization order and was redone through a factory.',
    decisions: [
      `piece ${index}: the order of edits is schema first, then the store, or the tests fail in bulk`,
      `piece ${index}: dropped the adapter layer, it would have cost tokens on every turn`,
      `piece ${index}: the check runs against the built dist, not the sources`,
    ],
    verifications: [
      { check: `npx vitest run tests/piece${index}.test.ts`, status: 'pass' },
      { check: 'npm run typecheck', status: 'pass' },
    ],
  };
}

const roots: string[] = [];
const stores: TaskStore[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), prefix));
  const root = join(project, '.state3');
  roots.push(project);
  return root;
}

function track(store: TaskStore): TaskStore {
  stores.push(store);
  return store;
}

afterEach(async () => {
  while (stores.length > 0) stores.pop()?.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** The text one prompt carries, or an empty string when the root has nothing to inject. */
function injectedText(root: string): string {
  const injection = readInjection(root);
  return injection.kind === 'context' ? (injection.task ?? '') : '';
}

describe('what a turn costs, tree against a flat plan', () => {
  /**
   * The measurement that justified the tree, as a test.
   *
   * It was a script in `.qwen/tmp` before, which is where a number goes to rot: the rendering
   * changes, the claim in the docs stays, and nothing fails. The point is not the exact count —
   * any wording tweak moves it — but the relation, so that is what is asserted: the tree costs a
   * fraction of the flat plan on the same work, and the fraction has margin enough to survive a
   * rewording and not enough to survive the tree losing its advantage.
   */
  it('carries a fraction of the state a flat plan would, on the same work', async () => {
    // --- The tree: three subtasks with their own Σ, the first one in flight. ---
    const treeRoot = await tempRoot('state3-cost-tree-');
    const tree = track(new TaskStore(treeRoot));
    const parent = await tree.start('Ship the release');
    for (const [index, piece] of PIECES.entries()) {
      const sub = await tree.start(piece, { parent: parent.meta.id });
      const work = workOf(index);
      await tree.patch(
        {
          'plan[+]': {
            id: '1',
            task: work.notes,
            status: index === 0 ? 'in_progress' : 'pending',
            notes: '',
          },
          decisions: work.decisions,
          verifications: work.verifications,
          ...(index === 0 ? { status: 'active' } : {}),
        },
        sub.meta.id,
      );
    }

    // --- The flat plan: one task, three steps, all of the state in one Σ. ---
    const flatRoot = await tempRoot('state3-cost-flat-');
    const flat = track(new TaskStore(flatRoot));
    await flat.start('Ship the release', { plan: [...PIECES] });
    const patch: StateDict = { 'plan[0].status': 'in_progress', decisions: [], verifications: [] };
    const decisions: string[] = [];
    const verifications: StateDict[] = [];
    for (let index = 0; index < PIECES.length; index++) {
      const work = workOf(index);
      patch[`plan[${index}].notes`] = work.notes;
      decisions.push(...work.decisions);
      verifications.push(...work.verifications);
    }
    patch.decisions = decisions;
    patch.verifications = verifications;
    await flat.patch(patch);

    const treeText = injectedText(treeRoot);
    const flatText = injectedText(flatRoot);
    expect(treeText.length).toBeGreaterThan(0);
    expect(flatText.length).toBeGreaterThan(0);

    // Measured at 47% when the tree landed; the bound leaves room for a rewording and none for
    // the advantage disappearing.
    expect(treeText.length).toBeLessThan(flatText.length * 0.6);

    // The size is the consequence; this is the cause. A flat plan carries the other two pieces on
    // every turn of the first one, and a tree carries neither.
    expect(flatText).toContain('piece 1:');
    expect(flatText).toContain('tests/piece2.test.ts');
    expect(treeText).not.toContain('piece 1:');
    expect(treeText).not.toContain('piece 2:');
    expect(treeText).not.toContain('tests/piece2.test.ts');
    // And the tree still says where the work sits and what follows, which is what it spends its
    // two extra lines on.
    expect(treeText).toContain('Branch: Ship the release');
    expect(treeText).toContain('Queued after this: "Rewrite the injection"');
  });
});

/**
 * What the two orientation lines cost once a goal stops being a label.
 *
 * Both ride on every prompt, and neither had a length bound: `BRANCH_NEAREST_LEVELS` capped the
 * depth of the branch line and nothing capped a segment, while the queue line quoted the next
 * sibling's goal whole. On the session of 27.09.2026 that measured 255 characters of container
 * goal — a changelog with ten commit hashes in it — and 442 characters of quoted sibling, 31% of
 * everything the injection carried besides Σ. The bounds are asserted against the constants
 * rather than against numbers measured once, so rewording a line does not break the test and
 * removing a cap does.
 */
describe('what the orientation lines cost when a goal grows', () => {
  /** The shape a container goal takes after a few pieces are closed under it. */
  function changelog(label: string): string {
    return (
      `${label} — closed 14 findings: 4156492, 72a635a, 17c360f, dc54f87, f753674, 587adf2, ` +
      'a5472dc, 6dd5a80, 12d633c, 0147c11; the sentence runs on past anything a label needs'
    );
  }

  /** The one line of an injection starting with `prefix`, or an empty string. */
  function lineOf(text: string, prefix: string): string {
    return text.split('\n').find((line) => line.startsWith(prefix)) ?? '';
  }

  it('cuts a container goal in the branch line and keeps its status readable', async () => {
    const root = await tempRoot('state3-cost-branch-');
    const store = track(new TaskStore(root));
    const goal = changelog('Review the cold start');
    const parent = await store.start(goal);
    const piece = await store.start('First piece', { parent: parent.meta.id });
    await store.patch({ status: 'active' }, piece.meta.id);

    const branch = lineOf(injectedText(root), 'Branch:');
    expect(branch).toContain('…');
    // The status sits outside the cap: which end of the queue an ancestor is at is the part a
    // reader acts on, and it is the goal that grows.
    expect(branch).toContain('[active]');
    expect(branch.length).toBeLessThanOrEqual(BRANCH_SEGMENT_CHARS + 40);
    expect(branch.length).toBeLessThan(goal.length);
  });

  it('cuts a sibling goal in the queue line and keeps the id a call needs', async () => {
    const root = await tempRoot('state3-cost-queue-');
    const store = track(new TaskStore(root));
    const parent = await store.start('Ship the release');
    const first = await store.start('First piece', { parent: parent.meta.id });
    const second = await store.start(changelog('Second piece'), { parent: parent.meta.id });
    await store.patch({ status: 'active' }, first.meta.id);

    const queue = lineOf(injectedText(root), 'Queued after this:');
    expect(queue).toContain('…');
    expect(queue).toContain(second.meta.id);
    expect(queue.length).toBeLessThanOrEqual(QUEUE_GOAL_CHARS + 90);
  });
});
