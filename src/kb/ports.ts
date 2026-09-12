import type { SqlDatabase } from '../db/database.js';
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
  get(id: string): PageRecord | null;
  list(filter?: PageFilter): PageSummary[];
  delete(id: string): boolean;
  count(): number;
  search(query: string, options?: SearchOptions): SearchHit[];
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
