import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { StateDict } from '../../src/core/types.js';
import { readInjection } from '../../src/tasks/inject.js';
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
