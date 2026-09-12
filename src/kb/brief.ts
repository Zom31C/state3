import type { SqlDatabase } from '../db/database.js';
import type { DatabaseOwner, PageStorePort } from './ports.js';
import { PAGE_KINDS, SINGLETON_PAGE_KINDS } from './schema.js';
import type { PageKind, PageSummary } from './schema.js';
import { PageStore } from './store.js';

/**
 * The cold-start brief: level L0 of the token pyramid.
 *
 * A session that knows nothing about a project needs one screen, not the project. So the brief
 * carries the SUMMARY of every page and the body of none, inside a hard budget, and ends by
 * naming the two calls that go deeper. Its cost grows with the number of pages, never with
 * their size — which is the whole reason `summary` is a required, length-capped field.
 *
 * The budget is in characters, not tokens: a tokenizer is not available here, and characters
 * are a stable proxy (about 4 per token in English, about 2 in Russian). The default is
 * deliberately generous for the reserved pages and tight for everything else.
 */
export const DEFAULT_BRIEF_BUDGET_CHARS = 4000;

/** Kept back for the closing line, so a full brief never grows past its budget. */
const FOOTER_RESERVE_CHARS = 160;

/** Kinds that get their own section, in the order a newcomer needs them. */
const SECTION_KINDS: readonly PageKind[] = PAGE_KINDS.filter(
  (kind): kind is PageKind => !(SINGLETON_PAGE_KINDS as readonly string[]).includes(kind),
);

function sectionTitle(kind: PageKind): string {
  if (kind === 'feature') return 'Features';
  if (kind === 'decision') return 'Decisions';
  return 'Notes';
}

export interface BriefOptions {
  budgetChars?: number;
}

/** One candidate line, in priority order; headers are entries too, so they can be dropped. */
interface Entry {
  text: string;
  /** False for a section header, which carries no page and must not be counted as dropped. */
  isPage: boolean;
  /** Section this entry belongs to, so a header left with no pages can be removed. */
  section: string;
}

/** Newest first inside a group, so a budget cut drops the pages nobody has touched. */
function byRecency(a: PageSummary, b: PageSummary): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return a.id < b.id ? -1 : 1;
}

function pinnedFirst(a: PageSummary, b: PageSummary): number {
  if (a.pin !== b.pin) return a.pin ? -1 : 1;
  return byRecency(a, b);
}

/** One line per page. `*` marks a pinned page; a status is printed only when it is not current. */
export function briefLine(page: PageSummary): string {
  const pin = page.pin ? ' *' : '';
  const status = page.status === 'current' ? '' : ` (${page.status})`;
  return `- ${page.id}${pin}${status}: ${page.title} — ${page.summary}`;
}

/**
 * Orders the pages a brief shows: the reserved singleton pages first, because they are the
 * answer to "what is this project and what does the user want", then pinned pages, then the
 * rest by kind. Archived pages are left out — they are kept for search, not for orientation.
 */
function orderedEntries(pages: readonly PageSummary[]): Entry[] {
  const visible = pages.filter((page) => page.status !== 'archived');
  const entries: Entry[] = [];

  const reserved: Entry[] = [];
  for (const kind of SINGLETON_PAGE_KINDS) {
    const page = visible.find((candidate) => candidate.kind === kind);
    if (page !== undefined) {
      // No title here — the id already names it — but the status is kept: a reserved page
      // marked stale (and every unfilled template is) must not read as documented truth.
      const status = page.status === 'current' ? '' : ` (${page.status})`;
      reserved.push({
        text: `- ${page.id}${status}: ${page.summary}`,
        isPage: true,
        section: 'reserved',
      });
    }
  }
  if (reserved.length > 0) {
    entries.push({ text: 'Start here:', isPage: false, section: 'reserved' });
    entries.push(...reserved);
  }

  const singletons = new Set(SINGLETON_PAGE_KINDS as readonly string[]);
  const rest = visible.filter((page) => !singletons.has(page.kind));
  const pinned = rest.filter((page) => page.pin).sort(byRecency);
  if (pinned.length > 0) {
    entries.push({ text: 'Pinned:', isPage: false, section: 'pinned' });
    for (const page of pinned) {
      entries.push({ text: briefLine(page), isPage: true, section: 'pinned' });
    }
  }

  for (const kind of SECTION_KINDS) {
    const group = rest.filter((page) => page.kind === kind && !page.pin).sort(pinnedFirst);
    if (group.length === 0) continue;
    entries.push({ text: `${sectionTitle(kind)}:`, isPage: false, section: kind });
    for (const page of group) {
      entries.push({ text: briefLine(page), isPage: true, section: kind });
    }
  }

  return entries;
}

/**
 * Renders the brief for a set of pages, cutting whole lines to stay inside the budget.
 *
 * Lines are dropped from the bottom of the priority order and never in half: a truncated
 * summary is worse than an absent one, because it reads as complete. What was cut is reported
 * with the call that lists it, so the reader knows the brief is partial and how to see the rest.
 */
export function buildBrief(pages: readonly PageSummary[], options: BriefOptions = {}): string {
  const budget = options.budgetChars ?? DEFAULT_BRIEF_BUDGET_CHARS;
  const archived = pages.filter((page) => page.status === 'archived').length;

  const header = [
    '# Project brief',
    'One line per page: what this project is, what the user wants from it, and what is documented. ' +
      'Nothing here is a body — read a page with page {"op":"get","id":"<id>"} and find anything with search {"query":"…"}.',
  ];

  const entries = orderedEntries(pages);
  const included: Entry[] = [];
  let used = header.join('\n').length + FOOTER_RESERVE_CHARS;
  let droppedPages = 0;
  let stopped = false;

  for (const entry of entries) {
    const cost = entry.text.length + 1;
    if (!stopped && used + cost <= budget) {
      included.push(entry);
      used += cost;
      continue;
    }
    stopped = true;
    if (entry.isPage) droppedPages += 1;
  }

  // A header whose pages were all cut would promise a section that never arrives.
  const sectionsWithPages = new Set(included.filter((entry) => entry.isPage).map((e) => e.section));
  const body = included
    .filter((entry) => entry.isPage || sectionsWithPages.has(entry.section))
    .map((entry) => entry.text);

  const sections: string[] = [...header];
  if (pages.length === 0) {
    sections.push(
      'This project has no knowledge base yet. The three pages worth writing first are ' +
        `${SINGLETON_PAGE_KINDS.join(', ')} — each is stored under its own kind as its id. ` +
        'Scaffold all three as templates with page {"op":"init"}.',
    );
  } else {
    sections.push(...body);
  }

  const tail: string[] = [];
  if (droppedPages > 0) {
    tail.push(
      `${droppedPages} more page(s) did not fit this brief — page {"op":"list"} lists every one.`,
    );
  }
  if (archived > 0) {
    tail.push(`${archived} archived page(s) left out; search still finds them.`);
  }
  if (tail.length > 0) sections.push(tail.join(' '));

  return sections.join('\n');
}

/** The brief of one state root, read through the page store. */
export function renderProjectBrief(pages: PageStorePort, options: BriefOptions = {}): string {
  return buildBrief(pages.list(), options);
}

/**
 * The brief of a connection the caller already holds, or null when that database has no pages.
 *
 * This is what the `inject-state` hook reads at session start: it has one handle open for Σ and
 * must not open a second one, so the page store borrows the handle instead of owning it. Null for
 * an empty knowledge base is the point of the signature — "nothing written down yet" costs a hook
 * nothing, while the brief that says so would be a few hundred characters at the start of every
 * session of every project that has never used the knowledge base. A tool answers that case in
 * full, with the three pages worth writing; a hook stays quiet.
 */
export function renderDatabaseBrief(db: SqlDatabase, options: BriefOptions = {}): string | null {
  const owner: DatabaseOwner = { database: () => db, readable: () => db };
  const pages = new PageStore(owner).list();
  return pages.length === 0 ? null : buildBrief(pages, options);
}
