import type { RejectCategory } from '../core/rejections.js';
import {
  CHURN_COMMIT_WINDOW,
  gitCommitsTouching,
  gitFileChurn,
  gitHead,
  gitTrackedFiles,
} from '../core/git.js';
import { issueCategory, issueSizeDetail } from '../core/validator.js';
import type { SqlDatabase } from '../db/database.js';
import { applyBodyEdits, appendToBody } from './body.js';
import type { BodyEdit } from './body.js';
import type {
  BodyRevision,
  BodyRevisionText,
  CoverageReport,
  DatabaseOwner,
  PageFreshness,
  StalePage,
  UncoveredFile,
} from './ports.js';
import {
  PAGE_BODY_HISTORY_LIMIT,
  isPageKind,
  isPageStatus,
  pageGuard,
  pageInputSchema,
} from './schema.js';
import type {
  PageFilter,
  PageInput,
  PageKind,
  PageRecord,
  PageRef,
  PageStatus,
  PageSummary,
} from './schema.js';
import { searchDatabase } from './search.js';
import type { SearchHit, SearchOptions } from './search.js';
import {
  decodeLines,
  decodeSourceFiles,
  encodeLines,
  encodeSourceFiles,
  extractSourceFiles,
  isDocumentableFile,
  symbolFile,
} from './sources.js';

export type { BodyRevision, BodyRevisionText, DatabaseOwner } from './ports.js';
export type { CoverageReport, PageFreshness, StalePage, UncoveredFile } from './ports.js';

/**
 * A refused page write. It carries the same rejection vocabulary as a refused task
 * patch, so the tool layer maps both to one hint table and an agent reads "guard"
 * the same way whichever half of the project it was writing.
 */
export class KbError extends Error {
  constructor(
    public readonly category: RejectCategory,
    message: string,
  ) {
    super(message);
    this.name = 'KbError';
  }
}

/** One `page` row. `pin` is SQLite's integer boolean. */
interface PageRow {
  id: string;
  kind: string;
  title: string;
  summary: string;
  body: string;
  parent: string | null;
  status: string;
  pin: number;
  source_commit: string | null;
  source_files: string;
  symbols: string;
  created_at: string;
  updated_at: string;
}

const PAGE_COLUMNS =
  'id, kind, title, summary, body, parent, status, pin, source_commit, source_files, ' +
  'symbols, created_at, updated_at';

/** Pinned first, then the most recently touched: what a reader wants from "what is here". */
const PAGE_ORDER = 'ORDER BY pin DESC, updated_at DESC, id';

/** How many pages the staleness report lists; the rest are reachable by raising the limit. */
export const STALE_PAGES_LIMIT = 20;

/** How many pages the report examines to find them: each one costs a git call. */
export const STALE_SCAN_LIMIT = 100;

/** How many uncovered files the coverage report lists; the rest are counted, not printed. */
export const COVERAGE_LIMIT = 30;

/**
 * One path as a comparison sees it.
 *
 * Windows resolves `Scripts/Car.cs` and `scripts/Car.cs` to the same file, and a page body
 * spells a path however the agent read it, so comparing the two literally would report a
 * documented file as a hole in the documentation — the one answer that makes a report
 * impossible to trust.
 */
function samePath(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

export class PageStore {
  constructor(private readonly owner: DatabaseOwner) {}

  /**
   * Creates or updates one page, by id.
   *
   * A field left out of an update keeps its stored value, and `parent: null` clears it —
   * the difference matters, because "re-parent to the root" and "leave the parent alone"
   * are different intentions and a model must be able to say either.
   */
  put(input: unknown): PageRecord {
    const parsed = pageInputSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      if (issue === undefined) throw new KbError('schema', 'Page validation failed.');
      const at = issue.path.length > 0 ? `at "${issue.path.join('.')}" ` : '';
      // The sent value, not the parsed one: a value that failed its length check has no
      // parsed form, and its actual size is the number the caller needs to shorten by.
      const size = issueSizeDetail(issue, input);
      throw new KbError(
        issueCategory(issue.code),
        `Page validation failed ${at}(${issue.code}): ${issue.message}` +
          (size === null ? '' : ` — ${size}`),
      );
    }
    const draft: PageInput = parsed.data;

    const db = this.owner.database();
    const now = new Date().toISOString();

    return db.transaction(() => {
      const current = this.rowOrNull(db, draft.id);
      if (current === null) {
        const missing = (['kind', 'title', 'summary'] as const).filter(
          (field) => draft[field] === undefined,
        );
        if (missing.length > 0) {
          throw new KbError(
            'schema',
            `a new page needs ${missing.join(', ')}; only an update may leave them out`,
          );
        }
      } else {
        // Refused here rather than merged around: an update that silently rewrote a kind
        // this build does not know would destroy information it cannot interpret.
        this.kindOf(current);
      }

      const body = draft.body ?? current?.body ?? '';
      const bodyChanged = current === null || current.body !== body;
      // The anchor moves only with the body. A page whose summary was corrected still
      // describes the code it described, and re-anchoring it would report a freshness
      // nobody checked — the exact false confidence the anchor exists to remove.
      const anchor = bodyChanged
        ? this.anchorFor(body)
        : {
            commit: current?.source_commit ?? null,
            files: decodeSourceFiles(current?.source_files ?? ''),
          };

      const page = this.merge(draft, current, now, anchor);
      const refusal = pageGuard(page, (id) => this.refOrNull(db, id));
      if (refusal !== null) throw new KbError('guard', refusal);

      // The body about to be replaced is the one worth keeping: it is the text a
      // reader may have cited a minute ago, and after this write nothing else holds
      // it. Recorded in the same transaction, so a page and its trail cannot disagree.
      if (current !== null && bodyChanged) {
        this.rememberBody(db, draft.id, current.body, now);
      }

      db.prepare(
        `INSERT INTO page (id, kind, title, summary, body, parent, status, pin, source_commit,
           source_files, symbols, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           kind = excluded.kind, title = excluded.title, summary = excluded.summary,
           body = excluded.body, parent = excluded.parent, status = excluded.status,
           pin = excluded.pin, source_commit = excluded.source_commit,
           source_files = excluded.source_files, symbols = excluded.symbols,
           updated_at = excluded.updated_at`,
      ).run(
        page.id,
        page.kind,
        page.title,
        page.summary,
        page.body,
        page.parent,
        page.status,
        page.pin ? 1 : 0,
        page.sourceCommit,
        encodeSourceFiles(page.sourceFiles),
        encodeLines(page.symbols),
        page.createdAt,
        page.updatedAt,
      );

      return page;
    });
  }

  /**
   * The commit and the files a body is anchored to.
   *
   * The commit is read at write time, not at read time, because it has to say what the tree
   * looked like when the page was written — asking later would answer a different question.
   * A project with no repository, and an owner that holds only a database handle, anchor to
   * null: the files are still worth recording, and "unknown" must stay distinguishable from
   * "nothing changed".
   */
  private anchorFor(body: string): { commit: string | null; files: string[] } {
    const projectDir = this.owner.projectDir?.();
    return {
      commit: projectDir === undefined ? null : gitHead(projectDir),
      files: extractSourceFiles(body),
    };
  }

  /**
   * Changes part of a page's body, instead of the whole of it.
   *
   * Every edit must address exactly one place in the text, and a refused edit leaves
   * the stored body untouched — the edits are applied to a copy and only written once
   * all of them landed. The write itself goes through `put`, so a patched body is
   * re-indexed for search and re-checked against the length limit like any other.
   */
  patchBody(id: string, edits: readonly BodyEdit[]): PageRecord {
    const current = this.get(id);
    if (current === null) throw this.noSuchPage(id, 'patch');

    const result = applyBodyEdits(current.body, edits);
    if (!result.ok) {
      throw new KbError(
        'path',
        `edit ${result.index + 1} of ${edits.length} refused: ${result.message}`,
      );
    }
    return this.put({ id, body: result.body });
  }

  /** Adds text at the end of a body: the cheapest way to record one more measurement. */
  appendBody(id: string, text: string): PageRecord {
    const current = this.get(id);
    if (current === null) throw this.noSuchPage(id, 'append');
    return this.put({ id, body: appendToBody(current.body, text) });
  }

  /**
   * `patch` and `append` need a page to change, and "there is none" is a different
   * answer from `put`'s: writing a body edit for a page that does not exist is a
   * mistaken id far more often than an intention to create it.
   */
  private noSuchPage(id: string, op: string): KbError {
    return new KbError(
      'guard',
      `no page "${id}" to ${op} — check the id with op "list", or create the page with op "put"`,
    );
  }

  /**
   * The bodies a page had before this one, newest first, without their text: a
   * listing costs a line per version, and reading one is a separate call. The current
   * body is not among them — that is what `get` returns — and a page that was never
   * rewritten has none.
   */
  bodyHistory(id: string, limit: number = PAGE_BODY_HISTORY_LIMIT): BodyRevision[] {
    const db = this.owner.readable();
    if (db === null) return [];
    const rows = db
      .prepare(
        `SELECT seq, at, length(body) AS chars FROM page_history
         WHERE page_id = ? ORDER BY seq DESC LIMIT ?`,
      )
      .all(id, limit) as BodyRevision[];
    return rows;
  }

  /**
   * One previous body in full, by the `seq` its history line printed. Addressed by
   * seq rather than by position in the listing, because a position shifts as soon as
   * the page is written again — and a version read silently turning into another one
   * is exactly the confusion this trail exists to remove.
   */
  bodyRevision(id: string, seq: number): BodyRevisionText | null {
    const db = this.owner.readable();
    if (db === null) return null;
    const row = db
      .prepare('SELECT at, body FROM page_history WHERE page_id = ? AND seq = ?')
      .get(id, seq) as BodyRevisionText | undefined;
    return row === undefined ? null : row;
  }

  /**
   * What this page is anchored to, and what has moved in the tree under it since.
   *
   * `changed` is null when the question has no answer — no repository, or a page written
   * before anchoring existed — and an empty list when the files are unchanged. Keeping those
   * apart is the whole point: a reader who cannot tell them apart learns to distrust every
   * page, including the ones that are current.
   */
  freshness(id: string): PageFreshness | null {
    const page = this.get(id);
    if (page === null) return null;
    const files = page.sourceFiles;
    // A page that names no file describes decisions and intent, which no commit can stale.
    if (files.length === 0) return { commit: page.sourceCommit, files, changed: [] };

    const projectDir = this.owner.projectDir?.();
    if (projectDir === undefined || page.sourceCommit === null) {
      return { commit: page.sourceCommit, files, changed: null };
    }
    return {
      commit: page.sourceCommit,
      files,
      changed: gitCommitsTouching(projectDir, page.sourceCommit, files),
    };
  }

  /**
   * The pages whose files changed after they were written, worst first.
   *
   * Scanned most-recently-updated first and capped, because each page costs a git call: a
   * report that took a minute on a large knowledge base would not be run at cold start,
   * which is the one moment it is worth reading.
   */
  stalePages(limit: number = STALE_PAGES_LIMIT): StalePage[] {
    const db = this.owner.readable();
    if (db === null) return [];
    const projectDir = this.owner.projectDir?.();
    if (projectDir === undefined) return [];
    const head = gitHead(projectDir);
    if (head === null) return [];

    const rows = db
      .prepare(
        `SELECT id, title, source_commit, source_files FROM page
          WHERE source_commit IS NOT NULL AND source_files <> '' AND status <> 'archived'
          ORDER BY updated_at DESC, id LIMIT ?`,
      )
      .all(STALE_SCAN_LIMIT) as {
      id: string;
      title: string;
      source_commit: string;
      source_files: string;
    }[];

    const stale: StalePage[] = [];
    for (const row of rows) {
      // Written against the current commit: nothing can have moved under it since.
      if (row.source_commit === head) continue;
      const files = decodeSourceFiles(row.source_files);
      if (files.length === 0) continue;
      const touches = gitCommitsTouching(projectDir, row.source_commit, files);
      if (touches === null || touches.length === 0) continue;

      const changed: string[] = [];
      for (const touch of touches) {
        for (const file of touch.files) {
          if (!changed.includes(file)) changed.push(file);
        }
      }
      stale.push({
        id: row.id,
        title: row.title,
        commit: row.source_commit,
        commits: touches.length,
        files: changed,
      });
      if (stale.length >= limit) break;
    }
    return stale.sort((a, b) => b.commits - a.commits || (a.id < b.id ? -1 : 1));
  }

  /**
   * The documentable files of this repository that no page names, most-changed first.
   *
   * Ranked by churn rather than listed: a project holds hundreds of files and an agent will
   * document two of them, so the answer has to say which two cost the most to keep
   * rediscovering. Two git calls answer it however big the tree is, which is what makes it
   * cheap enough to run at a cold start, where the question actually comes up.
   */
  coverage(limit: number = COVERAGE_LIMIT): CoverageReport {
    const none: CoverageReport = {
      tracked: null,
      covered: 0,
      uncovered: [],
      uncoveredTotal: 0,
      window: CHURN_COMMIT_WINDOW,
      pages: 0,
    };

    const projectDir = this.owner.projectDir?.();
    if (projectDir === undefined) return none;
    const tracked = gitTrackedFiles(projectDir);
    if (tracked === null) return none;

    const db = this.owner.readable();
    // Every page counts, an archived one included: the question is whether the file is written
    // down anywhere a search can reach, not whether the brief currently shows it.
    const rows =
      db === null
        ? []
        : (db.prepare('SELECT source_files, symbols FROM page').all() as {
            source_files: string;
            symbols: string;
          }[]);

    const named = new Set<string>();
    for (const row of rows) {
      for (const file of decodeSourceFiles(row.source_files)) named.add(samePath(file));
      // A symbol line names its file too, so documenting the symbol IS documenting the file:
      // a report that said otherwise would ask for a page that already exists.
      for (const symbol of decodeLines(row.symbols)) {
        const file = symbolFile(symbol);
        if (file !== null) named.add(samePath(file));
      }
    }

    const churn = gitFileChurn(projectDir) ?? new Map<string, number>();
    const uncovered: UncoveredFile[] = [];
    let covered = 0;
    let documentable = 0;
    for (const path of tracked) {
      if (!isDocumentableFile(path)) continue;
      documentable += 1;
      if (named.has(samePath(path))) {
        covered += 1;
        continue;
      }
      uncovered.push({ path, commits: churn.get(path) ?? 0 });
    }
    uncovered.sort((a, b) => b.commits - a.commits || (a.path < b.path ? -1 : 1));

    return {
      tracked: documentable,
      covered,
      uncovered: uncovered.slice(0, Math.max(limit, 1)),
      uncoveredTotal: uncovered.length,
      window: CHURN_COMMIT_WINDOW,
      pages: rows.length,
    };
  }

  /** Keeps the body being replaced, then drops the versions that no longer fit. */
  private rememberBody(db: SqlDatabase, pageId: string, body: string, at: string): void {
    db.prepare('INSERT INTO page_history (page_id, at, body) VALUES (?, ?, ?)').run(
      pageId,
      at,
      body,
    );
    db.prepare(
      `DELETE FROM page_history
        WHERE page_id = ? AND seq NOT IN (
          SELECT seq FROM page_history WHERE page_id = ? ORDER BY seq DESC LIMIT ?
        )`,
    ).run(pageId, pageId, PAGE_BODY_HISTORY_LIMIT);
  }

  /** One page with its body, or null when there is no such page. */
  get(id: string): PageRecord | null {
    const db = this.owner.readable();
    if (db === null) return null;
    const row = this.rowOrNull(db, id);
    return row === null ? null : this.recordOf(row);
  }

  /**
   * Pages without their bodies: the cheap level of the token pyramid. A row whose kind
   * this build does not know is skipped rather than failing the whole list — one damaged
   * row must not hide the rest of the project.
   */
  list(filter: PageFilter = {}): PageSummary[] {
    const db = this.owner.readable();
    if (db === null) return [];

    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.kind !== undefined) {
      where.push('kind = ?');
      params.push(filter.kind);
    }
    if (filter.statuses !== undefined && filter.statuses.length > 0) {
      where.push(`status IN (${filter.statuses.map(() => '?').join(', ')})`);
      params.push(...filter.statuses);
    }
    if (filter.parent !== undefined) {
      where.push(filter.parent === null ? 'parent IS NULL' : 'parent = ?');
      if (filter.parent !== null) params.push(filter.parent);
    }

    const sql = `SELECT ${PAGE_COLUMNS} FROM page${
      where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`
    } ${PAGE_ORDER}`;
    const rows = db.prepare(sql).all(...params) as PageRow[];

    const summaries: PageSummary[] = [];
    for (const row of rows) {
      if (!isPageKind(row.kind) || !isPageStatus(row.status)) continue;
      summaries.push({
        id: row.id,
        kind: row.kind,
        title: row.title,
        summary: row.summary,
        status: row.status,
        pin: row.pin === 1,
        parent: row.parent,
        updatedAt: row.updated_at,
      });
    }
    return summaries;
  }

  /**
   * Deletes a page. Children survive and become root pages (the schema sets their parent
   * to NULL); the edges that pointed at the page are deleted with it, in the same
   * transaction, so a deletion cannot leave the dangling links `doctor` reports.
   */
  delete(id: string): boolean {
    const db = this.owner.database();
    return db.transaction(() => {
      db.prepare(
        'DELETE FROM link WHERE (src_kind = ? AND src_id = ?) OR (dst_kind = ? AND dst_id = ?)',
      ).run('page', id, 'page', id);
      return db.prepare('DELETE FROM page WHERE id = ?').run(id).changes > 0;
    });
  }

  /** How many pages the project holds; `doctor` and the brief budget use it. */
  count(): number {
    const db = this.owner.readable();
    if (db === null) return 0;
    const row = db.prepare('SELECT count(*) AS n FROM page').get() as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /**
   * Full-text search over this root's tasks and pages together, one snippet per hit.
   * Lives here so the tool layer has one object to ask, and so searching a project that
   * has never stored anything is an empty answer rather than an error.
   */
  search(query: string, options: SearchOptions = {}): SearchHit[] {
    return searchDatabase(this.owner.readable(), query, options);
  }

  private merge(
    draft: PageInput,
    current: PageRow | null,
    now: string,
    anchor: { commit: string | null; files: string[] },
  ): PageRecord {
    const kind = draft.kind ?? (current === null ? undefined : this.kindOf(current));
    const title = draft.title ?? current?.title;
    const summary = draft.summary ?? current?.summary;
    if (kind === undefined || title === undefined || summary === undefined) {
      throw new KbError('schema', 'a page needs a kind, a title and a summary');
    }
    const status = draft.status ?? (current === null ? 'current' : this.statusOf(current));
    return {
      id: draft.id,
      kind,
      title,
      summary,
      body: draft.body ?? current?.body ?? '',
      parent: draft.parent === undefined ? (current?.parent ?? null) : draft.parent,
      status,
      pin: draft.pin ?? current?.pin === 1,
      sourceCommit: anchor.commit,
      sourceFiles: anchor.files,
      // Kept when it is not sent, like every other field: a body edit must not cost the page
      // the symbol list it was written with.
      symbols: draft.symbols ?? decodeLines(current?.symbols ?? ''),
      createdAt: current?.created_at ?? now,
      updatedAt: now,
    };
  }

  private recordOf(row: PageRow): PageRecord {
    return {
      id: row.id,
      kind: this.kindOf(row),
      title: row.title,
      summary: row.summary,
      body: row.body,
      parent: row.parent,
      status: this.statusOf(row),
      pin: row.pin === 1,
      sourceCommit: row.source_commit,
      sourceFiles: decodeSourceFiles(row.source_files),
      symbols: decodeLines(row.symbols),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private kindOf(row: PageRow): PageKind {
    if (isPageKind(row.kind)) return row.kind;
    throw new KbError(
      'schema',
      `page "${row.id}" holds kind "${row.kind}", which this build does not know ` +
        '(the database was changed by hand)',
    );
  }

  /** An unknown status is treated as the default rather than refused: it costs nothing and keeps the page readable. */
  private statusOf(row: PageRow): PageStatus {
    return isPageStatus(row.status) ? row.status : 'current';
  }

  private rowOrNull(db: SqlDatabase, id: string): PageRow | null {
    const row = db.prepare(`SELECT ${PAGE_COLUMNS} FROM page WHERE id = ?`).get(id) as
      PageRow | undefined;
    return row === undefined ? null : row;
  }

  private refOrNull(db: SqlDatabase, id: string): PageRef | null {
    const row = db.prepare('SELECT id, parent FROM page WHERE id = ?').get(id) as
      PageRef | undefined;
    return row === undefined ? null : row;
  }
}
