import { describe, expect, it } from 'vitest';
import {
  BODY_MAX_CHARS,
  PARENT_DEPTH_LIMIT,
  SUMMARY_MAX_CHARS,
  pageGuard,
  pageInputSchema,
} from '../../src/kb/schema.js';
import type { PageRef, ParentLookup } from '../../src/kb/schema.js';

/** Parent lookup over a fixed tree, so the guard is tested without a database. */
function lookupOf(pages: Record<string, string | null>): ParentLookup {
  return (id: string): PageRef | null => (id in pages ? { id, parent: pages[id] ?? null } : null);
}

const noParents = lookupOf({});

describe('pageInputSchema', () => {
  it('accepts a full page', () => {
    const parsed = pageInputSchema.safeParse({
      id: 'auth-feature',
      kind: 'feature',
      title: 'Authentication',
      summary: 'How a session proves who it is.',
      body: 'Tokens are verified in src/auth.ts.',
      parent: 'project',
      status: 'current',
      pin: true,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an update that carries only the id and the field that changed', () => {
    expect(pageInputSchema.safeParse({ id: 'project', body: 'rewritten' }).success).toBe(true);
  });

  it('rejects an unknown key, so a typo cannot silently store nothing', () => {
    const parsed = pageInputSchema.safeParse({ id: 'project', titel: 'oops' });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.code).toBe('unrecognized_keys');
  });

  it('rejects an id a model could not address back', () => {
    for (const id of ['', 'Project', 'has space', ' leading', '-leading', 'a'.repeat(65)]) {
      expect(pageInputSchema.safeParse({ id }).success, `id "${id}"`).toBe(false);
    }
  });

  it('caps the summary, because the brief pays for every character of it', () => {
    expect(
      pageInputSchema.safeParse({ id: 'p', summary: 'x'.repeat(SUMMARY_MAX_CHARS) }).success,
    ).toBe(true);
    expect(
      pageInputSchema.safeParse({ id: 'p', summary: 'x'.repeat(SUMMARY_MAX_CHARS + 1) }).success,
    ).toBe(false);
  });

  it('caps the body, because a page orients an agent instead of holding the code', () => {
    expect(
      pageInputSchema.safeParse({ id: 'p', body: 'x'.repeat(BODY_MAX_CHARS + 1) }).success,
    ).toBe(false);
  });

  it('rejects an empty title and an empty summary', () => {
    expect(pageInputSchema.safeParse({ id: 'p', title: '' }).success).toBe(false);
    expect(pageInputSchema.safeParse({ id: 'p', summary: '' }).success).toBe(false);
  });

  it('tells "no parent" from "clear the parent"', () => {
    expect(pageInputSchema.parse({ id: 'p' }).parent).toBeUndefined();
    expect(pageInputSchema.parse({ id: 'p', parent: null }).parent).toBeNull();
  });
});

describe('pageGuard', () => {
  it('accepts a root page of an ordinary kind', () => {
    expect(pageGuard({ id: 'auth', kind: 'feature', parent: null }, noParents)).toBeNull();
  });

  it('insists a singleton kind is stored under its own id', () => {
    expect(pageGuard({ id: 'overview', kind: 'project', parent: null }, noParents)).toContain(
      'its page id must be "project"',
    );
  });

  it('insists a reserved id carries the kind it belongs to', () => {
    expect(pageGuard({ id: 'onboarding', kind: 'note', parent: null }, noParents)).toContain(
      'reserved for the singleton "onboarding" page',
    );
  });

  it('accepts every singleton at its own id', () => {
    for (const kind of ['project', 'user-intent', 'onboarding'] as const) {
      expect(pageGuard({ id: kind, kind, parent: null }, noParents)).toBeNull();
    }
  });

  it('refuses a parent that is not there', () => {
    expect(pageGuard({ id: 'a', kind: 'note', parent: 'missing' }, noParents)).toContain(
      'parent "missing" does not exist',
    );
  });

  it('refuses a page parented to itself', () => {
    const lookup = lookupOf({ a: null });
    expect(pageGuard({ id: 'a', kind: 'note', parent: 'a' }, lookup)).toContain(
      'cannot be its own parent',
    );
  });

  it('refuses a parent that is already a descendant', () => {
    // b's parent is a, so making a's parent b would close the loop.
    const lookup = lookupOf({ a: null, b: 'a', c: 'b' });
    expect(pageGuard({ id: 'a', kind: 'note', parent: 'c' }, lookup)).toContain(
      'would make it its own ancestor',
    );
  });

  it('accepts a deep but honest tree', () => {
    const pages: Record<string, string | null> = { root: null };
    let previous = 'root';
    for (let depth = 1; depth < PARENT_DEPTH_LIMIT - 1; depth++) {
      const id = `p${depth}`;
      pages[id] = previous;
      previous = id;
    }
    expect(pageGuard({ id: 'leaf', kind: 'note', parent: previous }, lookupOf(pages))).toBeNull();
  });

  it('reports a chain deeper than the limit instead of walking it forever', () => {
    // A cycle made by hand: every page's parent is the next one, and the walk never ends.
    const pages: Record<string, string | null> = {};
    for (let depth = 0; depth < PARENT_DEPTH_LIMIT + 5; depth++) {
      pages[`p${depth}`] = `p${depth + 1}`;
    }
    pages[`p${PARENT_DEPTH_LIMIT + 5}`] = 'p0';

    const refusal = pageGuard({ id: 'leaf', kind: 'note', parent: 'p0' }, lookupOf(pages));
    expect(refusal).toContain('the page tree has a cycle');
  });

  it('refuses an unknown kind', () => {
    expect(pageGuard({ id: 'a', kind: 'wiki', parent: null }, noParents)).toContain(
      'unknown page kind "wiki"',
    );
  });
});
