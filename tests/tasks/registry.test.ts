import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { patchCategoryList } from '../../src/core/rejections.js';
import type { Skill } from '../../src/core/skill.js';
import { isPlainObject } from '../../src/core/state.js';
import type { StateDict } from '../../src/core/types.js';
import {
  builtinSkillRegistry,
  builtinSkills,
  createSkillRegistry,
  DEFAULT_SKILL_NAME,
} from '../../src/tasks/registry.js';
import {
  devTaskSchema,
  devTaskSkill,
  nextStepSchema,
  RISK_LEVELS,
  TASK_STATUSES,
} from '../../src/tasks/schema.js';
import { TaskPatchError, TaskStore } from '../../src/tasks/store.js';
import { superviseTaskSkill } from '../../src/tasks/supervise.js';

/* A hand-made skill for a domain the runtime knows nothing about: tending garden
 * beds. It proves the store, the guard, the path patches and finish() are driven
 * by the injected skill rather than by a built-in shape. */

const GARDEN_INSTRUCTIONS = `You are tending a garden. Record every bed you water and pick.

State dictionary (all keys required, strict schema):
- goal: what the season must deliver.
- status: "active" | "blocked" | "done".
- beds: array of { id, crop, watered, picked }.
- decisions: append-only log of choices, one line each.
- next: { action, risk } — the very next concrete step.`;

const gardenBedSchema = z.strictObject({
  id: z.string(),
  crop: z.string().min(1),
  watered: z.boolean(),
  picked: z.boolean(),
});

const gardenTaskSchema = z.strictObject({
  goal: z.string().min(1),
  status: z.enum(TASK_STATUSES),
  beds: z.array(gardenBedSchema),
  decisions: z.array(z.string()),
  next: nextStepSchema,
});

function gardenTaskGuard(state: StateDict, patch: StateDict): string | null {
  const patchStatus = patch.status;
  if (patchStatus !== undefined && state.status === 'done' && patchStatus !== state.status) {
    return 'the season is over; start a new task instead of reopening this one';
  }
  const beds = patch.beds;
  if (!Array.isArray(beds)) return null;
  for (const bed of beds) {
    if (!isPlainObject(bed)) continue;
    if (bed.picked === true && bed.watered !== true) {
      const id = typeof bed.id === 'string' && bed.id !== '' ? bed.id : '?';
      return `bed ${id} cannot be picked before it is watered`;
    }
  }
  return null;
}

function gardenTaskProgress(state: StateDict): { done: number; total: number } {
  const beds = state.beds;
  if (!Array.isArray(beds)) return { done: 0, total: 0 };
  let done = 0;
  for (const bed of beds) {
    if (isPlainObject(bed) && bed.picked === true) done += 1;
  }
  return { done, total: beds.length };
}

/** No `newPlanItem`: this skill's Σ has no plan array, so it takes no plan. */
function gardenTaskSkill(): Skill {
  return {
    name: 'garden-task',
    instructions: GARDEN_INSTRUCTIONS,
    schema: gardenTaskSchema,
    initialState: {
      goal: 'placeholder',
      status: 'active',
      beds: [],
      decisions: [],
      next: { action: 'List the beds to tend', risk: 'safe' },
    },
    guard: gardenTaskGuard,
    progress: gardenTaskProgress,
  };
}

describe('createSkillRegistry', () => {
  it('looks skills up by name, lists them in order and knows its default', () => {
    const garden = gardenTaskSkill();
    const dev = devTaskSkill();
    const registry = createSkillRegistry([garden, dev], 'garden-task');

    expect(registry.defaultName).toBe('garden-task');
    expect(registry.get('garden-task')).toBe(garden);
    expect(registry.get('dev-task')).toBe(dev);
    expect(registry.get('nope')).toBeUndefined();
    expect(registry.names()).toEqual(['garden-task', 'dev-task']);
    expect(registry.default()).toBe(garden);
  });

  it('defaults the default name to dev-task', () => {
    const registry = createSkillRegistry([devTaskSkill(), superviseTaskSkill()]);
    expect(registry.defaultName).toBe(DEFAULT_SKILL_NAME);
    expect(registry.default().name).toBe('dev-task');
  });

  it('throws when the default name is not in the list, naming what it has', () => {
    expect(() => createSkillRegistry([gardenTaskSkill()])).toThrow(
      /default skill "dev-task" is not in the registry \(has: garden-task\)/,
    );
    expect(() => createSkillRegistry([gardenTaskSkill()], 'supervise-task')).toThrow(
      /default skill "supervise-task" is not in the registry/,
    );
  });

  it('throws on an empty registry', () => {
    expect(() => createSkillRegistry([])).toThrow(/has: nothing/);
  });
});

describe('builtinSkillRegistry', () => {
  it('has exactly the two shipped skills, defaulting to dev-task', () => {
    const registry = builtinSkillRegistry();
    expect(registry.names()).toEqual(['dev-task', 'supervise-task']);
    expect(registry.defaultName).toBe('dev-task');
    expect(registry.default().name).toBe('dev-task');
    expect(registry.get('supervise-task')?.name).toBe('supervise-task');
    expect(registry.get('garden-task')).toBeUndefined();
  });

  it('ships skills whose initial state passes their own schema', () => {
    const skills = builtinSkills();
    expect(skills.map((skill) => skill.name)).toEqual(['dev-task', 'supervise-task']);
    for (const skill of skills) {
      expect(skill.instructions.trim().length).toBeGreaterThan(0);
      expect(skill.schema.safeParse(skill.initialState).success).toBe(true);
      expect(typeof skill.guard).toBe('function');
    }
  });

  it('gives a plan only to the skill whose Σ has a plan array', () => {
    expect(typeof devTaskSkill().newPlanItem).toBe('function');
    expect(superviseTaskSkill().newPlanItem).toBeUndefined();
  });
});

/* P is the only place an agent learns what its Σ means and what a rejection is.
 * These are the drift guards: they fail when a skill ships a Σ field, a status
 * or a rejection category that its own procedure never mentions. */
describe('the procedure P of every builtin skill', () => {
  it('names each category a patch can be rejected with', () => {
    const list = `(${patchCategoryList()})`;
    for (const skill of builtinSkills()) {
      expect(skill.instructions, `${skill.name}: P omits the categories ${list}`).toContain(list);
    }
  });

  it('documents every field of its own Σ', () => {
    for (const skill of builtinSkills()) {
      for (const field of Object.keys(skill.initialState)) {
        expect(skill.instructions, `${skill.name}: P does not document "${field}"`).toContain(
          field,
        );
      }
    }
  });

  it('names every task status and risk level the schema accepts', () => {
    for (const skill of builtinSkills()) {
      for (const value of [...TASK_STATUSES, ...RISK_LEVELS]) {
        expect(skill.instructions, `${skill.name}: P does not name "${value}"`).toContain(value);
      }
    }
  });
});

describe('a custom registry driving TaskStore', () => {
  let dir: string;
  let store: TaskStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'skillstate-garden-'));
    store = new TaskStore(dir, createSkillRegistry([gardenTaskSkill()], 'garden-task'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates a task in the custom domain, with no plan array anywhere', async () => {
    const task = await store.start('Tend the tomato beds');

    expect(task.meta.skill).toBe('garden-task');
    expect(task.meta.notation).toBe('plain');
    expect(task.state.goal).toBe('Tend the tomato beds');
    expect(task.state.beds).toEqual([]);
    expect('plan' in task.state).toBe(false);
    expect(gardenTaskSchema.safeParse(task.state).success).toBe(true);
    expect(devTaskSchema.safeParse(task.state).success).toBe(false);
    expect(store.skillNames()).toEqual(['garden-task']);
  });

  it('rejects a plan for a skill without newPlanItem', async () => {
    await expect(store.start('Tend the beds', { plan: ['water'] })).rejects.toThrow(
      /skill "garden-task" takes no plan/,
    );
  });

  it('patches the custom Σ, by path and wholesale', async () => {
    const task = await store.start('Tend the tomato beds');
    await store.patch(
      { beds: [{ id: '1', crop: 'tomato', watered: false, picked: false }] },
      task.meta.id,
    );

    const watered = await store.patch({ 'beds[0].watered': true }, task.meta.id);
    expect(watered.state.beds).toEqual([{ id: '1', crop: 'tomato', watered: true, picked: false }]);

    const appended = await store.patch(
      { 'beds[+]': { id: '2', crop: 'basil', watered: true, picked: false } },
      task.meta.id,
    );
    expect((appended.state.beds as unknown[]).length).toBe(2);
  });

  it('applies the custom guard, and reports it under the guard category', async () => {
    const task = await store.start('Tend the tomato beds');
    await store.patch(
      { beds: [{ id: '1', crop: 'tomato', watered: false, picked: false }] },
      task.meta.id,
    );

    await expect(store.patch({ 'beds[0].picked': true }, task.meta.id)).rejects.toThrow(
      TaskPatchError,
    );
    try {
      await store.patch({ 'beds[0].picked': true }, task.meta.id);
    } catch (error) {
      expect((error as TaskPatchError).category).toBe('guard');
      expect((error as TaskPatchError).message).toBe('bed 1 cannot be picked before it is watered');
    }

    const history = await store.history(task.meta.id);
    expect(history.some((entry) => !entry.ok && entry.error?.category === 'guard')).toBe(true);

    // Watering first makes the same pick acceptable.
    const picked = await store.patch(
      { 'beds[0].watered': true, 'beds[0].picked': true },
      task.meta.id,
    );
    expect((picked.state.beds as Array<Record<string, unknown>>)[0]?.['picked']).toBe(true);
  });

  it('rejects a key the custom schema does not have', async () => {
    const task = await store.start('Tend the tomato beds');
    await expect(store.patch({ harvest: 3 }, task.meta.id)).rejects.toThrow(TaskPatchError);
    try {
      await store.patch({ harvest: 3 }, task.meta.id);
    } catch (error) {
      expect((error as TaskPatchError).category).toBe('unknown-key');
    }
  });

  it('finishes through the shared status/decisions/next contract', async () => {
    const task = await store.start('Tend the tomato beds');
    await store.patch(
      { beds: [{ id: '1', crop: 'tomato', watered: true, picked: true }] },
      task.meta.id,
    );

    const finished = await store.finish('both beds picked', task.meta.id);
    expect(finished.state.status).toBe('done');
    expect(finished.state.decisions).toEqual(['both beds picked']);
    expect(finished.state.next).toEqual({
      action: 'None — task finished; the outcome is the last decisions entry.',
      risk: 'safe',
    });
    expect(gardenTaskSchema.safeParse(finished.state).success).toBe(true);

    // The custom guard still owns the domain rule about reopening.
    await expect(store.patch({ status: 'active' }, task.meta.id)).rejects.toThrow(
      /the season is over/,
    );
  });

  it('reports progress through the custom progress function', async () => {
    const task = await store.start('Tend the tomato beds');
    await store.patch(
      {
        beds: [
          { id: '1', crop: 'tomato', watered: true, picked: true },
          { id: '2', crop: 'basil', watered: true, picked: false },
        ],
      },
      task.meta.id,
    );

    const rows = await store.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.skill).toBe('garden-task');
    expect(rows[0]?.progressDone).toBe(1);
    expect(rows[0]?.progressTotal).toBe(2);
  });

  it('returns the custom procedure P, plus the notation appendix', async () => {
    const plain = await store.start('Tend the tomato beds');
    expect(store.instructionsFor(plain)).toContain('You are tending a garden');
    expect(store.instructionsFor(plain)).toBe(GARDEN_INSTRUCTIONS);
    expect(store.instructionsFor(plain)).not.toContain('## Notation: compact');

    const compact = await store.start('Tend the beds', { notation: 'compact' });
    expect(store.instructionsFor(compact)).toContain(GARDEN_INSTRUCTIONS);
    expect(store.instructionsFor(compact)).toContain('## Notation: compact');
  });

  it('refuses a skill the injected registry does not have', async () => {
    await expect(store.start('Review the worker', { skill: 'supervise-task' })).rejects.toThrow(
      /unknown skill "supervise-task" \(available: garden-task\)/,
    );
  });

  it('keeps the two builtin skills out of a custom registry', async () => {
    expect(store.skillNames()).toEqual(['garden-task']);
    expect(await store.list()).toEqual([]);
  });
});
