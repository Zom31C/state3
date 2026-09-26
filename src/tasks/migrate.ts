import { mkdir, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { readLegacyRoot } from './legacy.js';
import type { LegacyUnreadable } from './legacy.js';
import { migrateLegacyStateRoot, rootMigrationNote } from './migrate-root.js';
import { builtinSkillRegistry } from './registry.js';
import type { SkillRegistry } from './registry.js';
import { TaskStore } from './store.js';

export interface MigratedTask {
  id: string;
  skill: string;
  historyEntries: number;
  /** False when this runtime cannot read the row back: a foreign skill, or Σ that breaks its schema. */
  readable: boolean;
  reason?: string;
}

export interface MigrationReport {
  rootDir: string;
  dbPath: string;
  migrated: MigratedTask[];
  /** Already in the database, so left untouched: re-running migrate must be safe. */
  alreadyInDatabase: string[];
  unreadable: LegacyUnreadable[];
  /** Legacy files were moved here; null when they were deleted or left in place. */
  archivedTo: string | null;
  /** Legacy files taken out of the root, archived or deleted. */
  filesHandled: number;
  /**
   * What carrying the pre-rename root over did, when this run had to do it first. Null in the
   * ordinary case: a root that was never renamed, or one already carried over.
   */
  rootNote: string | null;
}

export interface MigrateOptions {
  readonly registry?: SkillRegistry;
  /** Delete the legacy files instead of moving them into an archive directory. */
  readonly purge?: boolean;
  /** Import into the database but leave the legacy files exactly where they are. */
  readonly keepFiles?: boolean;
}

/** `2026-09-11T09:40:00.000Z` is not a legal Windows directory name. */
function archiveName(now: Date): string {
  return `_migrated-${now.toISOString().replace(/[:.]/g, '-')}`;
}

function readability(
  registry: SkillRegistry,
  skillName: string,
  state: unknown,
): { readable: boolean; reason?: string } {
  const skill = registry.get(skillName);
  if (skill === undefined) {
    return {
      readable: false,
      reason: `skill "${skillName}" is not in this runtime (has: ${registry.names().join(', ')})`,
    };
  }
  const parsed = skill.schema.safeParse(state);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      readable: false,
      reason: `Σ does not satisfy "${skill.name}": ${
        issue === undefined ? 'unknown reason' : `${issue.message} at "${issue.path.join('.')}"`
      }`,
    };
  }
  return { readable: true };
}

/**
 * Moves a state root from the file layout (`<id>.json` + `<id>.history.jsonl` per task)
 * into the single `state.db`.
 *
 * Two properties matter more than speed here. The migration is **idempotent**: a task
 * already in the database is skipped, so an interrupted run can simply be repeated. And
 * it is **lossless by default**: every record is imported verbatim, including ones this
 * runtime cannot interpret, and the legacy files are moved into a timestamped archive
 * rather than deleted — `purge` is the only thing that removes them.
 */
export async function migrateRootToDatabase(
  rootDir: string,
  options: MigrateOptions = {},
): Promise<MigrationReport> {
  const registry = options.registry ?? builtinSkillRegistry();
  // Carried over before the legacy records are read: a project renamed while its state was
  // still in the JSON layout keeps those files under the old directory name, and reading the
  // new root first would answer "nothing to migrate" about a root full of history.
  const rootNote = rootMigrationNote(migrateLegacyStateRoot(rootDir));
  const legacy = await readLegacyRoot(rootDir);
  const store = new TaskStore(rootDir, registry);

  const report: MigrationReport = {
    rootDir,
    dbPath: store.dbPath,
    migrated: [],
    alreadyInDatabase: [],
    unreadable: legacy.unreadable,
    archivedTo: null,
    filesHandled: 0,
    rootNote,
  };

  try {
    for (const record of legacy.records) {
      if (store.has(record.id)) {
        report.alreadyInDatabase.push(record.id);
        continue;
      }

      store.importRecord({
        id: record.id,
        skill: record.skill,
        notation: record.notation,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        state: record.state,
      });
      if (record.history.length > 0) store.importHistory(record.id, record.history);

      const { readable, reason } = readability(registry, record.skill, record.state);
      const migrated: MigratedTask = {
        id: record.id,
        skill: record.skill,
        historyEntries: record.history.length,
        readable,
      };
      if (reason !== undefined) migrated.reason = reason;
      report.migrated.push(migrated);
    }

    if (legacy.files.length === 0 || options.keepFiles === true) return report;

    if (options.purge === true) {
      for (const file of legacy.files) await rm(file, { force: true });
      report.filesHandled = legacy.files.length;
      return report;
    }

    const archiveDir = join(rootDir, archiveName(new Date()));
    await mkdir(archiveDir, { recursive: true });
    for (const file of legacy.files) {
      await rename(file, join(archiveDir, basename(file)));
    }
    report.archivedTo = archiveDir;
    report.filesHandled = legacy.files.length;
    return report;
  } finally {
    store.close();
  }
}

/** Plain-text summary of a migration, one line per outcome. */
export function formatMigrationReport(report: MigrationReport): string {
  const lines: string[] = [`state root: ${report.rootDir}`, `database:   ${report.dbPath}`];
  if (report.rootNote !== null) lines.push(report.rootNote);

  if (report.migrated.length === 0 && report.alreadyInDatabase.length === 0) {
    lines.push('nothing to migrate: no legacy task records in this root');
  } else {
    lines.push(
      `migrated ${report.migrated.length} task(s), ${report.migrated.reduce(
        (total, task) => total + task.historyEntries,
        0,
      )} history entries`,
    );
    for (const task of report.migrated) {
      const flag = task.readable ? 'ok' : `NOT READABLE BY THIS RUNTIME — ${task.reason ?? '?'}`;
      lines.push(`  ${task.id}  ${task.skill}  history:${task.historyEntries}  ${flag}`);
    }
    if (report.alreadyInDatabase.length > 0) {
      lines.push(`already in the database, left untouched: ${report.alreadyInDatabase.join(', ')}`);
    }
  }

  for (const bad of report.unreadable) {
    lines.push(`UNREADABLE, left in place: ${bad.file} — ${bad.reason}`);
  }

  if (report.archivedTo !== null) {
    lines.push(
      `legacy files moved to ${report.archivedTo} (delete it once you trust the database)`,
    );
  } else if (report.filesHandled > 0) {
    lines.push(`legacy files deleted: ${report.filesHandled}`);
  }

  return lines.join('\n');
}
