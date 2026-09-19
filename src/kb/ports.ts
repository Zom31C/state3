import type { SqlDatabase } from '../db/database.js';
import type { CommitTouch } from '../core/git.js';
import type { BodyEdit } from './body.js';
import type { PageFilter, PageRecord, PageSummary } from './schema.js';
import type { SearchHit, SearchOptions } from './search.js';

/**
 * The task store owns the project's single connection and the knowledge base borrows it:
 * one project costs one open database, not one per concern. `readable` is what reads use,
 * so a project that has never stored anything still has no file on disk.
 */
export interface DatabaseOwner {
  database(): SqlDatabase;
  readable(): SqlDatabase | null;
  /**
   * The project directory this root belongs to, when the owner knows it. Anchoring a page to
   * a commit and checking whether the files it names have moved both need the working tree;
   * an owner that reads a bare handle (the session-start hook) has none, and then the
   * knowledge base simply records no anchor rather than guessing one.
   */
  projectDir?(): string;
}

/** What a page is anchored to, and what has moved in the tree under it since. */
export interface PageFreshness {
  /** The commit the body was written against; null when the project has no repository. */
  commit: string | null;
  /** Project files the body names, with `/` separators. */
  files: string[];
  /**
   * Commits after `commit` that touched one of `files`, oldest first. Null means "not
   * answerable" — no repository, or no commit to compare against — which must never be
   * read as "nothing changed".
   */
  changed: CommitTouch[] | null;
}

/** One page the staleness report lists. */
export interface StalePage {
  id: string;
  title: string;
  /** The commit the page was written against. */
  commit: string | null;
  /** How many commits since then touched the files it names: the report's sort key. */
  commits: number;
  /** The files those commits touched, in the order they first appear. */
  files: string[];
}

/** One end of a link. Polymorphic, like the `link` table: a task or a page. */
export interface LinkRef {
  kind: string;
  id: string;
}

export interface LinkEdge {
  src: LinkRef;
  rel: string;
  dst: LinkRef;
}

/** Which edges of a node to return: outgoing, incoming, or both. */
export type LinkDirection = 'out' | 'in' | 'both';

export const LINK_DIRECTIONS: readonly LinkDirection[] = ['out', 'in', 'both'];

export interface PageStorePort {
  put(input: unknown): PageRecord;
  /** Changes part of a stored body; every edit must match exactly once. */
  patchBody(id: string, edits: readonly BodyEdit[]): PageRecord;
  /** Adds text at the end of a stored body. */
  appendBody(id: string, text: string): PageRecord;
  get(id: string): PageRecord | null;
  /** The bodies this page had before the current one, newest first, without their text. */
  bodyHistory(id: string, limit?: number): BodyRevision[];
  /** One of those bodies in full, addressed by the seq its listing printed. */
  bodyRevision(id: string, seq: number): BodyRevisionText | null;
  /** What this page is anchored to and what has moved under it; null when there is no page. */
  freshness(id: string): PageFreshness | null;
  /** Pages whose files changed after they were written, worst first. */
  stalePages(limit?: number): StalePage[];
  list(filter?: PageFilter): PageSummary[];
  delete(id: string): boolean;
  count(): number;
  search(query: string, options?: SearchOptions): SearchHit[];
}

/**
 * One stored previous body, as a history listing shows it: when it was replaced and how
 * long it was, but not the text. Ten versions of a 20 KB page is 200 KB, so the listing
 * stays cheap and reading one is a separate call.
 */
export interface BodyRevision {
  seq: number;
  at: string;
  chars: number;
}

/** One stored previous body with its text, for the call that reads a single version. */
export interface BodyRevisionText {
  at: string;
  body: string;
}

export interface LinkStorePort {
  link(src: LinkRef, rel: string, dst: LinkRef): LinkEdge;
  unlink(src: LinkRef, rel: string, dst: LinkRef): boolean;
  linksOf(ref: LinkRef, direction?: LinkDirection): LinkEdge[];
}

/** The knowledge base of one state root. */
export interface KbStores {
  pages: PageStorePort;
  links: LinkStorePort;
}

/**
 * Picks the knowledge base a call applies to, mirroring `StoreResolver` for tasks: a
 * supervising session can read a worker project's pages, but only roots declared up front
 * are reachable.
 */
export interface KbResolver {
  kb(project?: string): KbStores;
}
