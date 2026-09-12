import type { RejectCategory } from '../core/rejections.js';
import { issueCategory } from '../core/validator.js';
import type { SqlDatabase } from '../db/database.js';
import type { DatabaseOwner } from './ports.js';
import { isPageKind, isPageStatus, pageGuard, pageInputSchema } from './schema.js';
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

export type { DatabaseOwner } from './ports.js';

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
  created_at: string;
  updated_at: string;
}

const PAGE_COLUMNS = 'id, kind, title, summary, body, parent, status, pin, created_at, updated_at';

/** Pinned first, then the most recently touched: what a reader wants from "what is here". */
const PAGE_ORDER = 'ORDER BY pin DESC, updated_at DESC, id';

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
      throw new KbError(
        issueCategory(issue.code),
        `Page validation failed ${at}(${issue.code}): ${issue.message}`,
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

      const page = this.merge(draft, current, now);
      const refusal = pageGuard(page, (id) => this.refOrNull(db, id));
      if (refusal !== null) throw new KbError('guard', refusal);

      db.prepare(
        `INSERT INTO page (id, kind, title, summary, body, parent, status, pin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           kind = excluded.kind, title = excluded.title, summary = excluded.summary,
           body = excluded.body, parent = excluded.parent, status = excluded.status,
           pin = excluded.pin, updated_at = excluded.updated_at`,
      ).run(
        page.id,
        page.kind,
        page.title,
        page.summary,
        page.body,
        page.parent,
        page.status,
        page.pin ? 1 : 0,
        page.createdAt,
        page.updatedAt,
      );

      return page;
    });
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

  private merge(draft: PageInput, current: PageRow | null, now: string): PageRecord {
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
