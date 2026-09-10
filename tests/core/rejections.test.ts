import { describe, expect, it } from 'vitest';
import {
  isRejectCategory,
  PATCH_REJECT_CATEGORIES,
  patchCategoryList,
  REJECT_CATEGORIES,
} from '../../src/core/rejections.js';

/* The vocabulary is pinned by hand here on purpose: it is what P prints, what
 * TaskPatchError carries and what the MCP hint table is keyed by, so adding a
 * category has to be a deliberate act in three places at once. */

describe('rejection vocabulary', () => {
  it('lists the patch categories, and adds notation for start', () => {
    expect(PATCH_REJECT_CATEGORIES).toEqual([
      'guard',
      'path',
      'unknown-key',
      'type-coercion',
      'schema',
      'skill',
    ]);
    expect(REJECT_CATEGORIES).toEqual([...PATCH_REJECT_CATEGORIES, 'notation']);
    expect(new Set(REJECT_CATEGORIES).size).toBe(REJECT_CATEGORIES.length);
  });

  it('prints the patch categories the way P names them', () => {
    expect(patchCategoryList()).toBe(PATCH_REJECT_CATEGORIES.join(', '));
    expect(patchCategoryList()).not.toContain('notation');
  });

  it('narrows known categories and rejects anything else', () => {
    for (const category of REJECT_CATEGORIES) {
      expect(isRejectCategory(category)).toBe(true);
    }
    expect(isRejectCategory('quantum-flux')).toBe(false);
    expect(isRejectCategory('')).toBe(false);
    expect(isRejectCategory(undefined)).toBe(false);
    expect(isRejectCategory(7)).toBe(false);
  });
});
