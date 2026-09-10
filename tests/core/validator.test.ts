import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Skill } from '../../src/core/skill.js';
import type { StateDict } from '../../src/core/types.js';
import { validatePatch } from '../../src/core/validator.js';

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: 'test-skill',
    instructions: 'a test robot.',
    schema: z.strictObject({
      shelf_0: z.string().nullable(),
      shelf_1: z.string().nullable(),
    }),
    initialState: { shelf_0: null, shelf_1: null },
    ...overrides,
  };
}

const state: StateDict = { shelf_0: null, shelf_1: 'widget' };

describe('validatePatch', () => {
  it('accepts a patch consistent with the schema', () => {
    expect(validatePatch(makeSkill(), state, { shelf_0: 'gadget' })).toEqual({ ok: true });
  });

  it('accepts an empty patch', () => {
    expect(validatePatch(makeSkill(), state, {})).toEqual({ ok: true });
  });

  it('rejects an unknown key', () => {
    const res = validatePatch(makeSkill(), state, { shelf_9: 'x' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.category).toBe('unknown-key');
      expect(res.message).toContain('shelf_9');
    }
  });

  it('rejects a wrong value type as type-coercion', () => {
    const res = validatePatch(makeSkill(), state, { shelf_0: 123 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.category).toBe('type-coercion');
      expect(res.message).toContain('shelf_0');
    }
  });

  it('validates the merged result, not the patch alone', () => {
    const skill = makeSkill({
      schema: z.strictObject({ count: z.number().min(5) }),
      initialState: { count: 10 },
    });
    expect(validatePatch(skill, { count: 10 }, { count: 3 }).ok).toBe(false);
    expect(validatePatch(skill, { count: 10 }, { count: 7 }).ok).toBe(true);
  });

  it('accepts null deletion of an optional key against the merged state', () => {
    const skill = makeSkill({
      schema: z.record(z.string(), z.string().nullable()),
      initialState: { pending: 'order-7' },
    });
    expect(validatePatch(skill, { pending: 'order-7' }, { pending: null })).toEqual({
      ok: true,
    });
  });

  it('runs the domain guard before schema validation', () => {
    const skill = makeSkill({
      guard: (current, patch) =>
        patch.shelf_1 !== undefined && patch.shelf_1 !== current.shelf_1 && current.shelf_1 !== null
          ? 'shelf_1 already holds an item'
          : null,
    });
    const res = validatePatch(skill, state, { shelf_1: 'other' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.category).toBe('guard');
      expect(res.message).toContain('already holds');
    }
    expect(validatePatch(skill, state, { shelf_0: 'gadget' }).ok).toBe(true);
  });
});
