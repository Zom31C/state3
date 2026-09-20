import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { projectDirOf } from '../core/paths.js';
import { isPlainObject } from '../core/state.js';
import type { StateValue } from '../core/types.js';
import { STATE_DB_FILENAME, openStateDatabase } from '../db/database.js';
import type { SqlDatabase } from '../db/database.js';
import { SCHEMA_VERSION } from '../db/schema.js';
import { describeDrift, driftedArtifacts, storedArtifactStamps } from './artifact-stamps.js';
import { readLegacyRoot } from './legacy.js';
import { builtinSkillRegistry } from './registry.js';
import type { SkillRegistry } from './registry.js';

export type FindingSeverity = 'ok' | 'warn' | 'fail';

/** How many drifted artifacts one report names; `doctor` answers for every task in the root. */
const DRIFT_FINDINGS_LIMIT = 10;

export interface Finding {
  severity: FindingSeverity;
  text: string;
}

export interface DoctorReport {
  rootDir: string;
  dbPath: string;
  databaseExists: boolean;
  sizeBytes: number;
  schemaVersion: number | null;
  /** Result of `PRAGMA quick_check`, or null when the database could not be opened. */
  integrity: string | null;
  counts: {
    tasks: number;
    taskHistory: number;
    pages: number;
    links: number;
    searchRows: number;
  };
  /** Task ids this runtime cannot interpret, with the reason. */
  unreadableTasks: { id: string; reason: string }[];
  /** `link` edges pointing at a task or page that is not there. */
  danglingLinks: { from: string; to: string; rel: string }[];
  findings: Finding[];
}

function count(db: SqlDatabase, sql: string): number {
  const row = db.prepare(sql).get() as { n: number } | undefined;
  return row?.n ?? 0;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Reports on a state root without changing it.
 *
 * The point is to answer "is this project's memory intact, and can this build read
 * all of it?" in one call — the question a fresh agent (or a user after an upgrade)
 * actually has, and the one that is otherwise only discoverable by hitting a failure.
 */
export async function inspectStateRoot(
  rootDir: string,
  registry: SkillRegistry = builtinSkillRegistry(),
): Promise<DoctorReport> {
  const dbPath = join(rootDir, STATE_DB_FILENAME);
  const findings: Finding[] = [];

  let sizeBytes = 0;
  let databaseExists = false;
  try {
    sizeBytes = (await stat(dbPath)).size;
    databaseExists = true;
  } catch {
    databaseExists = false;
  }

  const legacy = await readLegacyRoot(rootDir);
  if (legacy.records.length > 0) {
    findings.push({
      severity: 'warn',
      text:
        `${legacy.records.length} legacy JSON task record(s) are still in this root — ` +
        'run `skillstate task migrate` to move them into the database',
    });
  }
  for (const bad of legacy.unreadable) {
    findings.push({ severity: 'warn', text: `unreadable legacy file ${bad.file}: ${bad.reason}` });
  }

  const report: DoctorReport = {
    rootDir,
    dbPath,
    databaseExists,
    sizeBytes,
    schemaVersion: null,
    integrity: null,
    counts: { tasks: 0, taskHistory: 0, pages: 0, links: 0, searchRows: 0 },
    unreadableTasks: [],
    danglingLinks: [],
    findings,
  };

  if (!databaseExists) {
    if (legacy.records.length === 0) {
      findings.push({ severity: 'ok', text: 'no database yet; the first task_start creates it' });
    }
    return report;
  }

  let db: SqlDatabase;
  try {
    db = openStateDatabase(dbPath, { readOnly: true });
  } catch (err) {
    findings.push({ severity: 'fail', text: `cannot open the database: ${message(err)}` });
    return report;
  }

  // A diagnostic must never throw. A file that is not really a database opens lazily and
  // only fails on the first read, and "doctor broke" is the one answer that helps nobody.
  try {
    const version = db.pragma('user_version', { simple: true });
    report.schemaVersion = typeof version === 'number' ? version : null;
    if (report.schemaVersion !== SCHEMA_VERSION) {
      findings.push({
        severity: 'fail',
        text: `schema version ${String(report.schemaVersion)}, this build expects ${SCHEMA_VERSION}`,
      });
    }

    const quickCheck = db.pragma('quick_check', { simple: true });
    report.integrity = typeof quickCheck === 'string' ? quickCheck : String(quickCheck);
    findings.push({
      severity: report.integrity === 'ok' ? 'ok' : 'fail',
      text: `integrity check: ${report.integrity}`,
    });

    report.counts = {
      tasks: count(db, 'SELECT count(*) AS n FROM task'),
      taskHistory: count(db, 'SELECT count(*) AS n FROM task_history'),
      pages: count(db, 'SELECT count(*) AS n FROM page'),
      links: count(db, 'SELECT count(*) AS n FROM link'),
      searchRows: count(db, 'SELECT count(*) AS n FROM search'),
    };

    // The index is trigger-maintained, so a mismatch means a trigger was dropped or a
    // row was written past them — either way search would silently miss things.
    const indexed = report.counts.tasks + report.counts.pages;
    if (report.counts.searchRows !== indexed) {
      findings.push({
        severity: 'fail',
        text:
          `search index holds ${report.counts.searchRows} row(s) but there are ${indexed} ` +
          'task(s) and page(s) — the index is out of sync',
      });
    }

    const rows = db.prepare('SELECT id, skill, state FROM task').all() as {
      id: string;
      skill: string;
      state: string;
    }[];
    const projectDir = projectDirOf(rootDir);
    const drifted: { id: string; text: string }[] = [];
    for (const row of rows) {
      const skill = registry.get(row.skill);
      if (skill === undefined) {
        report.unreadableTasks.push({
          id: row.id,
          reason: `skill "${row.skill}" is not in this runtime (has: ${registry.names().join(', ')})`,
        });
        continue;
      }
      let state: StateValue;
      try {
        state = JSON.parse(row.state) as StateValue;
      } catch {
        report.unreadableTasks.push({ id: row.id, reason: 'state is not valid JSON' });
        continue;
      }
      if (!isPlainObject(state)) {
        report.unreadableTasks.push({ id: row.id, reason: 'state is not an object' });
        continue;
      }
      const parsed = skill.schema.safeParse(state);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        report.unreadableTasks.push({
          id: row.id,
          reason: `Σ does not satisfy "${skill.name}": ${
            issue === undefined ? 'unknown reason' : issue.message
          }`,
        });
      }

      // Σ describes a tree, and a file somebody changed by hand between sessions is the one
      // thing Σ cannot report about itself. Read defensively: a root from before stamps
      // existed has no table to read, which is not a defect worth a finding.
      if (drifted.length >= DRIFT_FINDINGS_LIMIT) continue;
      try {
        for (const item of driftedArtifacts(state, storedArtifactStamps(db, row.id), projectDir)) {
          drifted.push({ id: row.id, text: describeDrift(item) });
          if (drifted.length >= DRIFT_FINDINGS_LIMIT) break;
        }
      } catch {
        // No stamp table, or a file that cannot be stat'ed: nothing to compare against.
      }
    }
    for (const item of drifted) {
      findings.push({
        severity: 'warn',
        text: `task ${item.id} describes a file that moved since Σ was written: ${item.text}`,
      });
    }
    for (const task of report.unreadableTasks) {
      findings.push({
        severity: 'warn',
        text: `task ${task.id} is stored but this runtime cannot read it — ${task.reason}`,
      });
    }

    // link is polymorphic, so no foreign key can police it; dangling edges are reported.
    const edges = db.prepare('SELECT src_kind, src_id, rel, dst_kind, dst_id FROM link').all() as {
      src_kind: string;
      src_id: string;
      rel: string;
      dst_kind: string;
      dst_id: string;
    }[];
    for (const edge of edges) {
      const table = edge.dst_kind === 'page' ? 'page' : edge.dst_kind === 'task' ? 'task' : null;
      if (table === null) {
        report.danglingLinks.push({
          from: `${edge.src_kind}:${edge.src_id}`,
          to: `${edge.dst_kind}:${edge.dst_id}`,
          rel: edge.rel,
        });
        continue;
      }
      const found = db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(edge.dst_id);
      if (found === undefined) {
        report.danglingLinks.push({
          from: `${edge.src_kind}:${edge.src_id}`,
          to: `${edge.dst_kind}:${edge.dst_id}`,
          rel: edge.rel,
        });
      }
    }
    for (const edge of report.danglingLinks) {
      findings.push({
        severity: 'warn',
        text: `dangling link ${edge.from} -[${edge.rel}]-> ${edge.to}`,
      });
    }
  } catch (err) {
    findings.push({ severity: 'fail', text: `cannot inspect the database: ${message(err)}` });
  } finally {
    try {
      db.close();
    } catch {
      // A damaged database may not close cleanly; the finding above is the real answer.
    }
  }

  // A read-only connection cannot delete the WAL siblings when it closes, so a purely
  // diagnostic command would leave the root with MORE files than it found. Fold them back
  // — but only once this is confirmed to be a skillState database at the version this build
  // writes, so `doctor` never touches a foreign SQLite file it was pointed at by mistake.
  if (report.schemaVersion === SCHEMA_VERSION && report.integrity === 'ok') {
    try {
      openStateDatabase(dbPath, { mustExist: true }).close();
    } catch {
      // Tidying is best-effort; the findings above are what doctor owes the caller.
    }
  }

  const siblings = (await readdir(rootDir)).filter((name) =>
    name.startsWith(`${STATE_DB_FILENAME}-`),
  );
  if (siblings.length > 0) {
    findings.push({
      severity: 'ok',
      text:
        `${siblings.join(', ')} present: a connection is open now, or the last one did not ` +
        'close cleanly (SQLite recovers it on the next open)',
    });
  }

  if (findings.every((finding) => finding.severity === 'ok')) {
    findings.push({ severity: 'ok', text: 'nothing to fix' });
  }

  return report;
}

/** Plain-text report; `fail` first so the important line is the one a model reads. */
export function formatDoctorReport(report: DoctorReport): string {
  const order: Record<FindingSeverity, number> = { fail: 0, warn: 1, ok: 2 };
  const lines = [
    `state root: ${report.rootDir}`,
    report.databaseExists
      ? `database:   ${report.dbPath} (${report.sizeBytes} bytes, schema v${String(report.schemaVersion)})`
      : `database:   ${report.dbPath} (absent)`,
    `counts:     tasks ${report.counts.tasks}, history ${report.counts.taskHistory}, ` +
      `pages ${report.counts.pages}, links ${report.counts.links}, indexed ${report.counts.searchRows}`,
  ];

  const sorted = [...report.findings].sort((a, b) => order[a.severity] - order[b.severity]);
  for (const finding of sorted) {
    lines.push(`  ${finding.severity.toUpperCase().padEnd(4)} ${finding.text}`);
  }
  return lines.join('\n');
}
