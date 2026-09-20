/**
 * The single-file schema. One `.skillstate/state.db` holds everything skillState
 * knows about a project: task states Σ, their audit trail, and the knowledge base
 * (Confluence-like pages) that lets a context-free agent orient itself.
 *
 * Two rules shaped this layout:
 *
 * 1. **Σ stays one JSON document.** The skill registry is the extension point for
 *    new domains, so a task's shape is owned by its skill, not by SQL. Hot fields
 *    (status, goal, progress) are duplicated into columns purely so `list`,
 *    `activeId` and search can run without deserializing every Σ.
 *
 * 2. **The search index maintains itself.** Triggers, not application code, keep
 *    `search` in sync — a new write path cannot forget to index, which is the
 *    failure mode a hand-maintained index always eventually hits.
 */

/**
 * Schema version this build creates and expects, stored in `PRAGMA user_version`.
 * A database with a HIGHER version is refused (fail closed): a newer skillState
 * wrote it, and this build cannot know what it must preserve. A LOWER version is
 * migrated forward by `MIGRATIONS` below.
 */
export const SCHEMA_VERSION = 6;

/**
 * Previous bodies of a page, newest last, kept by the write path in `PageStore`.
 *
 * Σ has an audit trail and pages did not: a page could only be read as it is now,
 * so a paragraph lost to a careless rewrite was lost for good, and "who changed
 * this, and when" had no answer. Bodies are the largest thing here, so the store
 * keeps only the last few per page (`PAGE_BODY_HISTORY_LIMIT`) and nothing indexes
 * them — a stale version must never answer a search.
 */
const PAGE_HISTORY_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS page_history (
    seq     INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id TEXT NOT NULL REFERENCES page (id) ON DELETE CASCADE,
    at      TEXT NOT NULL,
    body    TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS page_history_page ON page_history (page_id, seq DESC)`,
];

/**
 * The commit a page was written against, and the files its body names.
 *
 * A page that says "the integrity bar is in scripts/Hud.cs:43" is a claim about a tree, and
 * the tree moves: an hour later the line is elsewhere and the page still reads as current.
 * Storing the anchor costs two columns and makes the claim checkable — `page get` reports
 * what changed since, and `page {"op":"stale"}` reports it for the whole knowledge base.
 */
const PAGE_SOURCE_SQL: readonly string[] = [
  `ALTER TABLE page ADD COLUMN source_commit TEXT`,
  `ALTER TABLE page ADD COLUMN source_files TEXT NOT NULL DEFAULT ''`,
];

/**
 * What a file artifact looked like when Σ was last written.
 *
 * Σ says what the agent produced; it cannot say that the file was changed afterwards by
 * somebody else. That is the case which breaks a cold start — Σ reads as current while the
 * tree has moved — so the file's own numbers are kept beside it and compared on read.
 *
 * A side table rather than fields of Σ because Σ is carried on every prompt of the task:
 * a stamp is worth one write per patch and one comparison per session start, and it is
 * worth nothing at all if it costs tokens on every turn in between.
 */
const ARTIFACT_STAMP_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS artifact_stamp (
    task_id      TEXT NOT NULL REFERENCES task (id) ON DELETE CASCADE,
    artifact_key TEXT NOT NULL,
    mtime_ms     INTEGER NOT NULL,
    size         INTEGER NOT NULL,
    at           TEXT NOT NULL,
    PRIMARY KEY (task_id, artifact_key)
  )`,
];

/**
 * One full-text index over tasks and pages together, and the triggers that keep it.
 *
 * A single query searches the whole project, and the triggers are what make that safe: a new
 * write path cannot forget to index, which is the failure a hand-maintained index always
 * eventually hits. `unicode61` tokenizes Cyrillic as well as Latin — the KB is written in the
 * user's language, and a search that only works in English would be worse than none.
 *
 * `symbols` is a column of its own rather than part of the body, because it is what a search
 * is most often after — "which file holds RoadMask" — and only its own column lets the
 * ranking put that above the same word mentioned in passing inside a paragraph. Substring
 * search over identifiers is not FTS's job; that path uses LIKE, which is free at
 * knowledge-base scale.
 */
const SEARCH_INDEX_SQL: readonly string[] = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
    ref_kind UNINDEXED,
    ref_id   UNINDEXED,
    title,
    summary,
    body,
    symbols,
    tokenize = 'unicode61 remove_diacritics 2'
  )`,

  // A task's searchable text is its goal plus the whole Σ document: an agent must be able to
  // find "which task decided X" without reading every state. A task holds no symbols.
  `CREATE TRIGGER IF NOT EXISTS search_task_insert AFTER INSERT ON task BEGIN
    INSERT INTO search (ref_kind, ref_id, title, summary, body, symbols)
    VALUES ('task', new.id, new.goal, '', new.state, '');
  END`,
  `CREATE TRIGGER IF NOT EXISTS search_task_update AFTER UPDATE ON task BEGIN
    DELETE FROM search WHERE ref_kind = 'task' AND ref_id = old.id;
    INSERT INTO search (ref_kind, ref_id, title, summary, body, symbols)
    VALUES ('task', new.id, new.goal, '', new.state, '');
  END`,
  `CREATE TRIGGER IF NOT EXISTS search_task_delete AFTER DELETE ON task BEGIN
    DELETE FROM search WHERE ref_kind = 'task' AND ref_id = old.id;
  END`,

  `CREATE TRIGGER IF NOT EXISTS search_page_insert AFTER INSERT ON page BEGIN
    INSERT INTO search (ref_kind, ref_id, title, summary, body, symbols)
    VALUES ('page', new.id, new.title, new.summary, new.body, new.symbols);
  END`,
  `CREATE TRIGGER IF NOT EXISTS search_page_update AFTER UPDATE ON page BEGIN
    DELETE FROM search WHERE ref_kind = 'page' AND ref_id = old.id;
    INSERT INTO search (ref_kind, ref_id, title, summary, body, symbols)
    VALUES ('page', new.id, new.title, new.summary, new.body, new.symbols);
  END`,
  `CREATE TRIGGER IF NOT EXISTS search_page_delete AFTER DELETE ON page BEGIN
    DELETE FROM search WHERE ref_kind = 'page' AND ref_id = old.id;
  END`,
];

/**
 * The symbols a page documents, one per line, as `Symbol — path/to/file.ext`.
 *
 * A body holds symbols in prose, so answering "who builds the bridges" meant reading the
 * page that happens to mention it. A structured field lets `search` return the file with the
 * hit, which is the whole distance between one call and a series of greps.
 */
const PAGE_SYMBOLS_SQL: readonly string[] = [
  `ALTER TABLE page ADD COLUMN symbols TEXT NOT NULL DEFAULT ''`,
];

/** Rows the rebuilt index is filled from: everything it indexes, in the shape it now has. */
const SEARCH_REINDEX_SQL: readonly string[] = [
  `INSERT INTO search (ref_kind, ref_id, title, summary, body, symbols)
     SELECT 'task', id, goal, '', state, '' FROM task`,
  `INSERT INTO search (ref_kind, ref_id, title, summary, body, symbols)
     SELECT 'page', id, title, summary, body, symbols FROM page`,
];

/**
 * Rebuilds the search index so that it carries `page.symbols`.
 *
 * Its own migration step, and not folded into the one that adds the column, because an FTS5
 * table cannot gain a column: the index has to be dropped and refilled. A database that was
 * stamped with the column but without the rebuild — which is what a build carrying only the
 * first half leaves behind — is then permanently inconsistent while still reporting the
 * current version, and `search` fails on a column the index does not have. Two steps, each
 * with its own version, is what makes that state repairable by opening the file.
 *
 * The triggers go first: they are stored apart from the table they write to, so they survive
 * `DROP TABLE` and would keep inserting five columns into a six-column index. Replacing them
 * cannot be left to `CREATE TRIGGER IF NOT EXISTS`, which does not replace anything.
 */
const SEARCH_SYMBOLS_SQL: readonly string[] = [
  'DROP TRIGGER IF EXISTS search_task_insert',
  'DROP TRIGGER IF EXISTS search_task_update',
  'DROP TRIGGER IF EXISTS search_page_insert',
  'DROP TRIGGER IF EXISTS search_page_update',
  'DROP TABLE IF EXISTS search',
  ...SEARCH_INDEX_SQL,
  ...SEARCH_REINDEX_SQL,
];

/** Statements run in order, inside one transaction, to create the current version. */
export const SCHEMA_SQL: readonly string[] = [
  // Free-form per-project settings and counters that do not deserve a table.
  `CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS task (
    id             TEXT PRIMARY KEY,
    skill          TEXT NOT NULL,
    notation       TEXT NOT NULL,
    status         TEXT NOT NULL,
    goal           TEXT NOT NULL DEFAULT '',
    state          TEXT NOT NULL,
    progress_done  INTEGER NOT NULL DEFAULT 0,
    progress_total INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  )`,

  // `updated_at DESC, id DESC` makes "most recently updated open task" deterministic
  // even when two writes land in the same millisecond.
  `CREATE INDEX IF NOT EXISTS task_recent ON task (updated_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS task_status ON task (status)`,

  // Replaces the per-task `*.history.jsonl` sidecar. Rejected patches are stored
  // too: the audit trail has to show what did NOT apply, and why.
  `CREATE TABLE IF NOT EXISTS task_history (
    seq      INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id  TEXT NOT NULL REFERENCES task (id) ON DELETE CASCADE,
    at       TEXT NOT NULL,
    ok       INTEGER NOT NULL,
    category TEXT,
    message  TEXT,
    patch    TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS history_task ON task_history (task_id, seq)`,

  /**
   * Knowledge-base pages: project description, user intent, onboarding guide,
   * features, decisions. `summary` is the one-line abstract that appears in the
   * cold-start brief — it is what keeps the brief small no matter how large the
   * page bodies grow, which is how the entry point scales with the size of the
   * project rather than with the size of the current task.
   */
  `CREATE TABLE IF NOT EXISTS page (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    title      TEXT NOT NULL,
    summary    TEXT NOT NULL DEFAULT '',
    body       TEXT NOT NULL DEFAULT '',
    parent     TEXT REFERENCES page (id) ON DELETE SET NULL,
    status     TEXT NOT NULL DEFAULT 'current',
    pin        INTEGER NOT NULL DEFAULT 0,
    source_commit TEXT,
    source_files  TEXT NOT NULL DEFAULT '',
    symbols       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS page_kind ON page (kind, pin DESC, id)`,
  `CREATE INDEX IF NOT EXISTS page_parent ON page (parent)`,

  ...PAGE_HISTORY_SQL,
  ...ARTIFACT_STAMP_SQL,

  /**
   * Directed, typed edges between anything addressable (task→page, page→page).
   * Polymorphic on purpose, so no foreign key can express it: `doctor` reports
   * dangling edges instead of the schema rejecting them.
   */
  `CREATE TABLE IF NOT EXISTS link (
    src_kind TEXT NOT NULL,
    src_id   TEXT NOT NULL,
    rel      TEXT NOT NULL,
    dst_kind TEXT NOT NULL,
    dst_id   TEXT NOT NULL,
    PRIMARY KEY (src_kind, src_id, rel, dst_kind, dst_id)
  )`,
  `CREATE INDEX IF NOT EXISTS link_dst ON link (dst_kind, dst_id)`,

  ...SEARCH_INDEX_SQL,
];

/**
 * Forward migrations keyed by the version they UPGRADE FROM. Each entry brings the
 * database to `key + 1`, and every entry is also part of `SCHEMA_SQL`, so a database
 * created today and one migrated from an older build end up identical. A database
 * created before versioning existed is handled by the JSON migrator instead.
 */
export const MIGRATIONS: ReadonlyMap<number, readonly string[]> = new Map([
  // 1 -> 2: pages gained a body history, so a careless rewrite can be undone.
  [1, PAGE_HISTORY_SQL],
  // 2 -> 3: pages gained the commit and the files they describe, so a stale one says so.
  [2, PAGE_SOURCE_SQL],
  // 3 -> 4: file artifacts gained a stamp, so Σ can say the tree moved under it.
  [3, ARTIFACT_STAMP_SQL],
  // 4 -> 5: pages gained the symbols they document.
  [4, PAGE_SYMBOLS_SQL],
  // 5 -> 6: the search index gained that column, which an FTS5 table cannot do in place.
  [5, SEARCH_SYMBOLS_SQL],
]);

/** Tables `doctor` checks for dangling `link` edges. */
export const LINKABLE_KINDS = ['task', 'page'] as const;

export type LinkableKind = (typeof LINKABLE_KINDS)[number];

export function isLinkableKind(value: unknown): value is LinkableKind {
  return typeof value === 'string' && (LINKABLE_KINDS as readonly string[]).includes(value);
}
