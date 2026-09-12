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
export const SCHEMA_VERSION = 1;

/** Statements run in order, inside one transaction, to create version 1. */
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
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS page_kind ON page (kind, pin DESC, id)`,
  `CREATE INDEX IF NOT EXISTS page_parent ON page (parent)`,

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

  /**
   * One full-text index over tasks and pages together, so a single query searches
   * the whole project. `unicode61` tokenizes Cyrillic as well as Latin — the KB is
   * written in the user's language, and a search that only works in English would
   * be worse than none. Substring search over identifiers is not FTS's job; that
   * path uses LIKE, which is free at knowledge-base scale.
   */
  `CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
    ref_kind UNINDEXED,
    ref_id   UNINDEXED,
    title,
    summary,
    body,
    tokenize = 'unicode61 remove_diacritics 2'
  )`,

  // A task's searchable text is its goal plus the whole Σ document: an agent must
  // be able to find "which task decided X" without reading every state.
  `CREATE TRIGGER IF NOT EXISTS search_task_insert AFTER INSERT ON task BEGIN
    INSERT INTO search (ref_kind, ref_id, title, summary, body)
    VALUES ('task', new.id, new.goal, '', new.state);
  END`,
  `CREATE TRIGGER IF NOT EXISTS search_task_update AFTER UPDATE ON task BEGIN
    DELETE FROM search WHERE ref_kind = 'task' AND ref_id = old.id;
    INSERT INTO search (ref_kind, ref_id, title, summary, body)
    VALUES ('task', new.id, new.goal, '', new.state);
  END`,
  `CREATE TRIGGER IF NOT EXISTS search_task_delete AFTER DELETE ON task BEGIN
    DELETE FROM search WHERE ref_kind = 'task' AND ref_id = old.id;
  END`,

  `CREATE TRIGGER IF NOT EXISTS search_page_insert AFTER INSERT ON page BEGIN
    INSERT INTO search (ref_kind, ref_id, title, summary, body)
    VALUES ('page', new.id, new.title, new.summary, new.body);
  END`,
  `CREATE TRIGGER IF NOT EXISTS search_page_update AFTER UPDATE ON page BEGIN
    DELETE FROM search WHERE ref_kind = 'page' AND ref_id = old.id;
    INSERT INTO search (ref_kind, ref_id, title, summary, body)
    VALUES ('page', new.id, new.title, new.summary, new.body);
  END`,
  `CREATE TRIGGER IF NOT EXISTS search_page_delete AFTER DELETE ON page BEGIN
    DELETE FROM search WHERE ref_kind = 'page' AND ref_id = old.id;
  END`,
];

/**
 * Forward migrations keyed by the version they UPGRADE FROM. Each entry brings the
 * database to `key + 1`. Empty for now: version 1 is the first versioned schema,
 * and a database created before versioning existed is handled by the JSON migrator
 * rather than by a SQL migration.
 */
export const MIGRATIONS: ReadonlyMap<number, readonly string[]> = new Map();

/** Tables `doctor` checks for dangling `link` edges. */
export const LINKABLE_KINDS = ['task', 'page'] as const;

export type LinkableKind = (typeof LINKABLE_KINDS)[number];

export function isLinkableKind(value: unknown): value is LinkableKind {
  return typeof value === 'string' && (LINKABLE_KINDS as readonly string[]).includes(value);
}
