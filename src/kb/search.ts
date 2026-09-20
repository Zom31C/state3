import type { SqlDatabase } from '../db/database.js';
import type { PageSummary } from './schema.js';

/** One search result: what it is, and the piece of it that matched. */
export interface SearchHit {
  /** `task` or `page`. */
  kind: string;
  id: string;
  title: string;
  /** Matched text with the match wrapped in `[ ]`, trimmed to a few tokens. */
  snippet: string;
}

export interface SearchOptions {
  limit?: number;
  /** Restrict to one kind of thing; omit to search tasks and pages together. */
  kind?: string;
}

export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 50;
/** Tokens of context FTS5 keeps on each side of a match. */
const SNIPPET_TOKENS = 8;
/** Characters of context the substring fallback keeps, since LIKE has no snippet function. */
const FALLBACK_CHARS = 60;

interface FtsRow {
  ref_kind: string;
  ref_id: string;
  title: string;
  title_snippet: string;
  summary_snippet: string;
  body_snippet: string;
  symbols_snippet: string;
}

interface LikeRow {
  ref_kind: string;
  ref_id: string;
  title: string;
  summary: string;
  body: string;
  symbols: string;
}

/**
 * Turns arbitrary model-typed text into a safe MATCH expression: every whitespace-separated
 * word becomes a quoted phrase, and the phrases are ANDed. Quoting is what makes it safe —
 * a query containing `"`, `(`, `NOT` or `*` would otherwise be a syntax error, and an agent
 * searching for a literal `plan[+]` should get results, not a refusal. The price is that
 * FTS operators cannot be used, which is the right trade for a tool a model drives.
 */
export function ftsExpression(query: string): string {
  return query
    .split(/\s+/)
    .filter((word) => word !== '')
    .map((word) => `"${word.replace(/"/g, '""')}"`)
    .join(' ');
}

/** Escapes the LIKE wildcards, so searching for `50%` finds a literal percent sign. */
function likePattern(query: string): string {
  const escaped = query.replace(/[\\%_]/g, (char) => `\\${char}`);
  return `%${escaped}%`;
}

/**
 * The column whose snippet actually contains the match; FTS5 marks it with the brackets.
 *
 * Symbols first: a line there is `Name — path/to/file.ext`, so it is the only snippet that
 * answers "where does this live" without the reader opening anything, and a match in it is
 * the reason the field exists.
 */
function pickSnippet(row: FtsRow): string {
  for (const candidate of [
    row.symbols_snippet,
    row.body_snippet,
    row.summary_snippet,
    row.title_snippet,
  ]) {
    if (candidate.includes('[')) return candidate.trim();
  }
  return row.title;
}

function fallbackSnippet(row: LikeRow, query: string): string {
  const needle = query.toLowerCase();
  for (const text of [row.symbols, row.body, row.summary, row.title]) {
    const at = text.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    const from = Math.max(0, at - FALLBACK_CHARS);
    const to = Math.min(text.length, at + needle.length + FALLBACK_CHARS);
    const prefix = from > 0 ? '…' : '';
    const suffix = to < text.length ? '…' : '';
    const match = text.slice(at, at + needle.length);
    return `${prefix}${text.slice(from, at)}[${match}]${text.slice(at + needle.length, to)}${suffix}`.replace(
      /\s+/g,
      ' ',
    );
  }
  return row.summary === '' ? row.title : row.summary;
}

/**
 * Full-text search over tasks and pages at once.
 *
 * FTS5 goes first, because it ranks and it tokenizes Cyrillic. When it finds nothing the
 * query falls back to a substring scan: an identifier like `expandPathPatch` is one token to
 * the tokenizer, so a search for `PathPatch` is invisible to the index but is exactly what an
 * agent looking for a helper function types. At knowledge-base scale the scan is instant, and
 * it costs no second index.
 *
 * Returns [] rather than throwing when there is no database: searching an empty project is a
 * normal thing to do.
 */
export function searchDatabase(
  db: SqlDatabase | null,
  query: string,
  options: SearchOptions = {},
): SearchHit[] {
  if (db === null) return [];
  const trimmed = query.trim();
  if (trimmed === '') return [];

  const limit = Math.min(Math.max(options.limit ?? DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);
  const kindFilter = options.kind === undefined ? '' : ' AND ref_kind = ?';
  const kindParams = options.kind === undefined ? [] : [options.kind];

  const expression = ftsExpression(trimmed);
  if (expression !== '') {
    try {
      // Weights per column (ref_kind, ref_id, title, summary, body, symbols): a word in the
      // title says more about a page than the same word buried in a body, and a word in the
      // symbol list is the one that names a file. bm25 ranks ascending.
      const rows = db
        .prepare(
          `SELECT ref_kind, ref_id, title,
                  snippet(search, 2, '[', ']', ' … ', ${SNIPPET_TOKENS}) AS title_snippet,
                  snippet(search, 3, '[', ']', ' … ', ${SNIPPET_TOKENS}) AS summary_snippet,
                  snippet(search, 4, '[', ']', ' … ', ${SNIPPET_TOKENS}) AS body_snippet,
                  snippet(search, 5, '[', ']', ' … ', ${SNIPPET_TOKENS}) AS symbols_snippet
           FROM search
           WHERE search MATCH ?${kindFilter}
           ORDER BY bm25(search, 0, 0, 10, 5, 1, 8)
           LIMIT ?`,
        )
        .all(expression, ...kindParams, limit) as FtsRow[];
      if (rows.length > 0) {
        return rows.map((row) => ({
          kind: row.ref_kind,
          id: row.ref_id,
          title: row.title,
          snippet: pickSnippet(row),
        }));
      }
    } catch {
      // A query the index refuses is not an error worth surfacing: the substring pass below
      // answers it, and "search broke" helps nobody who just wanted to find a page.
    }
  }

  const pattern = likePattern(trimmed);
  const rows = db
    .prepare(
      `SELECT ref_kind, ref_id, title, summary, body, symbols FROM search
       WHERE (title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\'
              OR symbols LIKE ? ESCAPE '\\')${kindFilter}
       LIMIT ?`,
    )
    .all(pattern, pattern, pattern, pattern, ...kindParams, limit) as LikeRow[];

  return rows.map((row) => ({
    kind: row.ref_kind,
    id: row.ref_id,
    title: row.title,
    snippet: fallbackSnippet(row, trimmed),
  }));
}

/** How many pages a miss names as the nearest by topic. */
export const NEAREST_PAGES_LIMIT = 3;

/** Shorter words carry no topic: "the", "как" and "a" are in every page and say nothing. */
const MIN_TOPIC_WORD_CHARS = 3;

/** One page a miss points at, and the query words that made it the nearest. */
export interface NearestPage {
  id: string;
  title: string;
  summary: string;
  /** Query words this page's title or summary also holds. */
  shared: string[];
}

/** The words of a text that could carry a topic: letters and digits, lowercased, long enough. */
function topicWords(text: string): Set<string> {
  const words = new Set<string>();
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (word.length >= MIN_TOPIC_WORD_CHARS) words.add(word);
  }
  return words;
}

/**
 * True when a query word and a page word are the same word as far as a topic goes.
 *
 * Prefix rather than equality, because the queries that miss are usually identifiers — and
 * `RoadNetwork` has to be near a page titled "Road network", which no exact match would ever
 * connect. Prefix and not substring, so `car` does not become a match inside `scar`.
 */
function sameTopic(query: string, word: string): boolean {
  return query.startsWith(word) || word.startsWith(query);
}

/**
 * The pages nearest to a query that matched nothing, nearest first.
 *
 * A miss is the expensive answer to search for: on its own it says only that the knowledge
 * base cannot help, and the next move is a guess. Naming the pages that at least share the
 * query's vocabulary turns it into a choice — read one of those, or accept that the topic is
 * not written down and go to the tree.
 */
export function nearestPages(
  pages: readonly PageSummary[],
  query: string,
  limit: number = NEAREST_PAGES_LIMIT,
): NearestPage[] {
  const wanted = [...topicWords(query)];
  if (wanted.length === 0) return [];

  const scored: NearestPage[] = [];
  for (const page of pages) {
    const words = topicWords(`${page.title} ${page.summary}`);
    if (words.size === 0) continue;
    const shared = wanted.filter((word) =>
      [...words].some((candidate) => sameTopic(word, candidate)),
    );
    if (shared.length === 0) continue;
    scored.push({ id: page.id, title: page.title, summary: page.summary, shared });
  }
  return scored
    .sort((a, b) => b.shared.length - a.shared.length || (a.id < b.id ? -1 : 1))
    .slice(0, Math.max(limit, 1));
}
