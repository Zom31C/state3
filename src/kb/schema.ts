import { z } from 'zod';

/**
 * The page model: the Confluence half of "Jira + Confluence for an LLM".
 *
 * A page is a small, stable document — what the project is, what the user wants,
 * how to start working in it, what a feature does, why a decision was taken. The
 * code itself stays in the repository; a page is what lets an agent with no
 * context find the code that matters.
 *
 * Two fields carry the token economy. `summary` is the one-line abstract that the
 * cold-start brief shows, so the brief grows with the NUMBER of pages and not with
 * their size. `pin` keeps a page in that brief even when it has not been touched
 * in months, which is what a project description needs and a decision record does not.
 */
export const PAGE_KINDS = [
  'project',
  'user-intent',
  'onboarding',
  'feature',
  'decision',
  'note',
] as const;

export type PageKind = (typeof PAGE_KINDS)[number];

/**
 * Kinds a project holds exactly one of, and which the brief reads first. Their page
 * id IS the kind, so a cold agent can ask for `project` without listing anything.
 */
export const SINGLETON_PAGE_KINDS = ['project', 'user-intent', 'onboarding'] as const;

export type SingletonPageKind = (typeof SINGLETON_PAGE_KINDS)[number];

export const PAGE_STATUSES = ['current', 'stale', 'archived'] as const;

export type PageStatus = (typeof PAGE_STATUSES)[number];

/** Mirrors PROJECT_NAME in src/tasks/projects.ts: ids are typed by a model, so they are constrained. */
export const PAGE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const TITLE_MAX_CHARS = 200;
/** The brief shows one of these per page, so a long summary defeats the point of having one. */
export const SUMMARY_MAX_CHARS = 200;
/** A page orients an agent; a 200 KB page is a file dump, and the repository already holds the files. */
export const BODY_MAX_CHARS = 20_000;

/**
 * Previous bodies kept per page, newest first.
 *
 * Enough to undo a rewrite made this session and to answer "what did this page say
 * before", which is the loss the history exists to prevent. A body is the largest
 * thing stored here, so the trail is deliberately short and the oldest entry is
 * dropped on the write that overflows it.
 */
export const PAGE_BODY_HISTORY_LIMIT = 10;

/** A deeper chain than this is a cycle somebody made by hand, not a tree. */
export const PARENT_DEPTH_LIMIT = 100;

export function isPageKind(value: unknown): value is PageKind {
  return typeof value === 'string' && (PAGE_KINDS as readonly string[]).includes(value);
}

export function isSingletonPageKind(value: string): value is SingletonPageKind {
  return (SINGLETON_PAGE_KINDS as readonly string[]).includes(value);
}

export function isPageStatus(value: unknown): value is PageStatus {
  return typeof value === 'string' && (PAGE_STATUSES as readonly string[]).includes(value);
}

/**
 * What `put` accepts. Every field but `id` is optional because `put` is create-or-update:
 * a field that is absent keeps its stored value, and `parent: null` clears it. The store
 * refuses to CREATE a page without kind, title and summary — it cannot know that from the
 * shape alone, so the schema stays permissive and the store checks it against the row.
 */
export const pageInputSchema = z.strictObject({
  id: z.string().regex(PAGE_ID, 'a page id is lowercase letters, digits, "-" and "_", 1-64 chars'),
  kind: z.enum(PAGE_KINDS).optional(),
  title: z.string().min(1).max(TITLE_MAX_CHARS).optional(),
  summary: z.string().min(1).max(SUMMARY_MAX_CHARS).optional(),
  body: z.string().max(BODY_MAX_CHARS).optional(),
  parent: z.string().regex(PAGE_ID).nullish(),
  status: z.enum(PAGE_STATUSES).optional(),
  pin: z.boolean().optional(),
});

export type PageInput = z.infer<typeof pageInputSchema>;

/** A stored page. `body` is included; the list and brief views drop it. */
export interface PageRecord {
  id: string;
  kind: PageKind;
  title: string;
  summary: string;
  body: string;
  parent: string | null;
  status: PageStatus;
  pin: boolean;
  /**
   * The commit this body was written against, and the project files it names. Both are
   * derived on write, never sent by a caller: the agent does not know HEAD, and the file
   * list is read out of the body so it cannot disagree with it. A null commit means the
   * project has no repository to anchor to, which is not the same as "nothing changed".
   */
  sourceCommit: string | null;
  sourceFiles: string[];
  createdAt: string;
  updatedAt: string;
}

/** A page without its body: what listing and the cold-start brief cost. */
export interface PageSummary {
  id: string;
  kind: PageKind;
  title: string;
  summary: string;
  status: PageStatus;
  pin: boolean;
  parent: string | null;
  updatedAt: string;
}

/** Which pages a listing asks for; every field is optional and they combine. */
export interface PageFilter {
  kind?: PageKind;
  /** Only these statuses; omit to list every page. */
  statuses?: readonly PageStatus[];
  /** `null` lists root pages; omit to list pages at any depth. */
  parent?: string | null;
}

/** Enough of a page to walk the tree; the guard takes this so tests need no database. */
export interface PageRef {
  id: string;
  parent: string | null;
}

export type ParentLookup = (id: string) => PageRef | null;

/**
 * Domain guard for the merged candidate page. Deterministic; never throws.
 * Returns null when the page is acceptable, or an English message saying why not.
 */
export function pageGuard(page: PageRef & { kind: string }, lookup: ParentLookup): string | null {
  if (!isPageKind(page.kind)) {
    return `unknown page kind "${page.kind}" (expected one of: ${PAGE_KINDS.join(', ')})`;
  }

  // A singleton is addressed by its kind. Allowing any other id would give a cold agent
  // two ways to ask for the project page, and the brief a second copy of it to pay for.
  if (isSingletonPageKind(page.kind) && page.id !== page.kind) {
    return `kind "${page.kind}" is a singleton: its page id must be "${page.kind}"`;
  }
  if (isSingletonPageKind(page.id) && page.kind !== page.id) {
    return `page id "${page.id}" is reserved for the singleton "${page.id}" page, not for kind "${page.kind}"`;
  }

  if (page.parent === null) return null;
  if (page.parent === page.id) return 'a page cannot be its own parent';

  const parent = lookup(page.parent);
  if (parent === null) return `parent "${page.parent}" does not exist`;

  // The new parent must not already be a descendant, or the tree gains a cycle that no
  // reader can walk. The depth limit turns a cycle somebody else made into an error
  // instead of a hang.
  let cursor: PageRef | null = parent;
  for (let depth = 0; depth < PARENT_DEPTH_LIMIT; depth++) {
    if (cursor === null) return null;
    if (cursor.id === page.id) {
      return `parent "${page.parent}" is a descendant of "${page.id}", which would make it its own ancestor`;
    }
    cursor = cursor.parent === null ? null : lookup(cursor.parent);
  }
  return `the parent chain above "${page.id}" is deeper than ${PARENT_DEPTH_LIMIT}: the page tree has a cycle`;
}
