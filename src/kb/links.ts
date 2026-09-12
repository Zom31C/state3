import { isLinkableKind } from '../db/schema.js';
import type { SqlDatabase } from '../db/database.js';
import type { DatabaseOwner, LinkDirection, LinkEdge, LinkRef } from './ports.js';
import { KbError } from './store.js';

/**
 * Relation names are typed by a model, so they are constrained the way page ids are — but the
 * vocabulary stays open. A closed list would push an agent to pick a wrong word from it; an
 * open one with a suggested vocabulary in the tool description gets `documents`, `implements`
 * and `decides` in practice, and `explains-the-retry-logic` when nothing standard fits.
 */
export const LINK_REL = /^[a-z][a-z0-9_-]{0,31}$/;

export const SUGGESTED_LINK_RELS = ['documents', 'implements', 'decides', 'supersedes', 'see-also'];

interface LinkRow {
  src_kind: string;
  src_id: string;
  rel: string;
  dst_kind: string;
  dst_id: string;
}

/**
 * Directed, typed edges between the things a project holds: a task and the page that describes
 * it, a decision and the feature it shapes.
 *
 * Both ends must exist in this state root. The `link` table is polymorphic, so no foreign key
 * can enforce that, and `doctor` reports a dangling edge as damage — refusing it here is what
 * keeps that report meaningful. A link to a task in another project's root is therefore not
 * expressible, which is honest: this database cannot see that task.
 */
export class LinkStore {
  constructor(private readonly owner: DatabaseOwner) {}

  /** Adds an edge. Idempotent: linking the same triple twice stores it once. */
  link(src: LinkRef, rel: string, dst: LinkRef): LinkEdge {
    const relation = rel.trim();
    if (!LINK_REL.test(relation)) {
      throw new KbError(
        'schema',
        `rel "${rel}" must be 1-32 chars of lowercase letters, digits, "-" or "_", starting with a letter`,
      );
    }

    const db = this.owner.database();
    this.requirePresent(db, src, 'from');
    this.requirePresent(db, dst, 'to');
    if (src.kind === dst.kind && src.id === dst.id) {
      throw new KbError('guard', `${src.kind} "${src.id}" cannot link to itself`);
    }

    db.prepare(
      'INSERT OR IGNORE INTO link (src_kind, src_id, rel, dst_kind, dst_id) VALUES (?, ?, ?, ?, ?)',
    ).run(src.kind, src.id, relation, dst.kind, dst.id);

    return {
      src: { kind: src.kind, id: src.id },
      rel: relation,
      dst: { kind: dst.kind, id: dst.id },
    };
  }

  /** Removes an edge, reporting whether there was one. */
  unlink(src: LinkRef, rel: string, dst: LinkRef): boolean {
    const db = this.owner.database();
    return (
      db
        .prepare(
          'DELETE FROM link WHERE src_kind = ? AND src_id = ? AND rel = ? AND dst_kind = ? AND dst_id = ?',
        )
        .run(src.kind, src.id, rel.trim(), dst.kind, dst.id).changes > 0
    );
  }

  /** Edges touching a node. `both` is the default, since a reader usually wants the neighbourhood. */
  linksOf(ref: LinkRef, direction: LinkDirection = 'both'): LinkEdge[] {
    if (!isLinkableKind(ref.kind)) {
      throw new KbError('schema', `expected a "task" or a "page", got "${ref.kind}"`);
    }
    const db = this.owner.readable();
    if (db === null) return [];

    const where =
      direction === 'out'
        ? 'src_kind = ? AND src_id = ?'
        : direction === 'in'
          ? 'dst_kind = ? AND dst_id = ?'
          : '(src_kind = ? AND src_id = ?) OR (dst_kind = ? AND dst_id = ?)';
    const params = direction === 'both' ? [ref.kind, ref.id, ref.kind, ref.id] : [ref.kind, ref.id];

    const rows = db
      .prepare(
        `SELECT src_kind, src_id, rel, dst_kind, dst_id FROM link WHERE ${where} ORDER BY rel, src_id, dst_id`,
      )
      .all(...params) as LinkRow[];

    return rows.map((row) => ({
      src: { kind: row.src_kind, id: row.src_id },
      rel: row.rel,
      dst: { kind: row.dst_kind, id: row.dst_id },
    }));
  }

  private requirePresent(db: SqlDatabase, ref: LinkRef, label: string): void {
    if (!isLinkableKind(ref.kind)) {
      throw new KbError('schema', `${label} must be a "task" or a "page", got "${ref.kind}"`);
    }
    const table = ref.kind === 'page' ? 'page' : 'task';
    const found = db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(ref.id);
    if (found === undefined) {
      throw new KbError(
        'guard',
        `${label} ${ref.kind} "${ref.id}" is not in this state root — create the page first, or check the id`,
      );
    }
  }
}
