import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { isPlainObject } from '../core/state.js';
import type { StateDict } from '../core/types.js';
import type { SqlDatabase } from '../db/database.js';
import { isPathLikeArtifact } from './artifacts.js';

/**
 * What a file artifact looked like when Σ was last written, and whether it still does.
 *
 * `artifacts` says what the agent produced, and a check exists for a path that is not there
 * at all (`missingArtifactPaths`, at write time). The case that breaks a cold start is the
 * other one: the path is there, Σ reads as current, and the file was changed by somebody
 * else between sessions. Nothing in Σ can say so, because Σ is a record of what the agent
 * knew — so the runtime keeps the file's own numbers beside it and compares them on read.
 *
 * The stamps live in the database and never in Σ: Σ is carried on every prompt of the task,
 * and a per-turn tax to catch a once-a-week surprise is the wrong trade.
 */

/** How many drifted artifacts one report names before the list stops being readable. */
const REPORT_LIMIT = 5;

/** The two numbers that move when a file's contents do. */
export interface FileStamp {
  /** Milliseconds since the epoch, rounded: sub-millisecond precision is not a real edit. */
  mtimeMs: number;
  size: number;
}

/** A stored stamp: the file as it was at the patch that recorded it. */
export interface ArtifactStamp extends FileStamp {
  /** The artifact key exactly as Σ spells it, which is what a report can be read against. */
  key: string;
  /** When Σ was last written. */
  at: string;
}

/** One artifact whose file is no longer what Σ was written against. */
export interface DriftedArtifact {
  key: string;
  /** When Σ was last written, and so when the stamp was taken. */
  recordedAt: string;
  /** The file's modification time now, or null when the file is gone. */
  modifiedAt: string | null;
  /** Minutes between that patch and the file's mtime; null when the mtime is not later. */
  minutesAfter: number | null;
}

/** The file an artifact key names, resolved against the project the state root belongs to. */
export function artifactFile(key: string, projectDir: string): string {
  return isAbsolute(key) ? key : join(projectDir, key);
}

/**
 * What the disk says about a path, or null when there is nothing to stamp.
 *
 * Only regular files are stamped. A directory's mtime moves whenever anything inside it is
 * created or removed, so stamping one would report drift for a folder the agent named as a
 * place its work lives — which is exactly the `.qwen/tmp/` style key Σ tends to carry.
 */
export function stampOnDisk(file: string): FileStamp | null {
  try {
    const info = statSync(file);
    if (!info.isFile()) return null;
    return { mtimeMs: Math.round(info.mtimeMs), size: info.size };
  } catch {
    // Absent, unreadable or a broken link: nothing to compare against, and a diagnostic
    // must not be the thing that fails a patch.
    return null;
  }
}

/** The path-like artifact keys of Σ, in the order Σ holds them. */
export function artifactKeys(state: StateDict): string[] {
  const artifacts = state.artifacts;
  if (!isPlainObject(artifacts)) return [];
  return Object.keys(artifacts).filter(isPathLikeArtifact);
}

/**
 * Re-stamps the file artifacts of a task, inside the transaction that writes Σ.
 *
 * Every patch re-stamps, not only one that touches `artifacts`: a stamp means "the tree
 * looked like this when Σ was last written", and a patch is the moment Σ is written. Stamping
 * only on an `artifacts` patch would report the agent's own edits as drift for the rest of
 * the task, which is noise exactly where the warning is supposed to be trusted.
 *
 * Keys that left Σ lose their row, so the table does not grow with every artifact a task
 * ever named.
 */
export function recordArtifactStamps(
  db: SqlDatabase,
  taskId: string,
  state: StateDict,
  projectDir: string,
  at: string,
): void {
  const keys = artifactKeys(state);
  const keep = new Set<string>();

  for (const key of keys) {
    const stamp = stampOnDisk(artifactFile(key, projectDir));
    if (stamp === null) continue;
    keep.add(key);
    db.prepare(
      `INSERT INTO artifact_stamp (task_id, artifact_key, mtime_ms, size, at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (task_id, artifact_key) DO UPDATE SET
         mtime_ms = excluded.mtime_ms, size = excluded.size, at = excluded.at`,
    ).run(taskId, key, stamp.mtimeMs, stamp.size, at);
  }

  if (keep.size === 0) {
    db.prepare('DELETE FROM artifact_stamp WHERE task_id = ?').run(taskId);
    return;
  }
  db.prepare(
    `DELETE FROM artifact_stamp
      WHERE task_id = ? AND artifact_key NOT IN (${[...keep].map(() => '?').join(', ')})`,
  ).run(taskId, ...keep);
}

/** The stamps stored for one task, by artifact key; empty when it has none. */
export function storedArtifactStamps(db: SqlDatabase, taskId: string): Map<string, ArtifactStamp> {
  const rows = db
    .prepare('SELECT artifact_key, mtime_ms, size, at FROM artifact_stamp WHERE task_id = ?')
    .all(taskId) as { artifact_key: string; mtime_ms: number; size: number; at: string }[];

  const stamps = new Map<string, ArtifactStamp>();
  for (const row of rows) {
    stamps.set(row.artifact_key, {
      key: row.artifact_key,
      mtimeMs: row.mtime_ms,
      size: row.size,
      at: row.at,
    });
  }
  return stamps;
}

/** An ISO time a person can read next to another one: seconds are enough to tell them apart. */
function readable(iso: string | number): string {
  const text = typeof iso === 'number' ? new Date(iso).toISOString() : iso;
  return text.replace(/\.\d{3}Z$/, 'Z');
}

/**
 * The artifacts whose file moved since Σ was last written.
 *
 * A key with no stored stamp is skipped rather than reported as unknown: it was recorded by
 * a build that had no stamps, or it names a directory, and the next patch stamps it. Saying
 * "cannot tell" about every artifact of every older task would drown the one that matters.
 */
export function driftedArtifacts(
  state: StateDict,
  stamps: ReadonlyMap<string, ArtifactStamp>,
  projectDir: string,
): DriftedArtifact[] {
  if (stamps.size === 0) return [];

  const drifted: DriftedArtifact[] = [];
  for (const key of artifactKeys(state)) {
    const recorded = stamps.get(key);
    if (recorded === undefined) continue;

    const now = stampOnDisk(artifactFile(key, projectDir));
    if (now !== null && now.mtimeMs === recorded.mtimeMs && now.size === recorded.size) continue;

    const recordedAt = Date.parse(recorded.at);
    const minutesAfter =
      now === null || Number.isNaN(recordedAt) || now.mtimeMs <= recordedAt
        ? null
        : Math.round((now.mtimeMs - recordedAt) / 60_000);
    drifted.push({
      key,
      recordedAt: recorded.at,
      modifiedAt: now === null ? null : readable(now.mtimeMs),
      minutesAfter,
    });
  }
  return drifted;
}

/** One drifted artifact as it reads in a report. */
export function describeDrift(item: DriftedArtifact): string {
  if (item.modifiedAt === null) return `${item.key} (no longer on disk)`;
  const later =
    item.minutesAfter === null ? '' : `, ${item.minutesAfter} min after Σ was last written`;
  return `${item.key} (modified ${readable(item.modifiedAt)}${later})`;
}

/**
 * The lines a read adds for artifacts the disk disagrees with; empty when it agrees.
 *
 * A warning, never a refusal, and it names the time Σ was written as well as the file's own:
 * the point is not that a file changed but that Σ describes a tree that no longer exists,
 * which is the premise a resumed session would otherwise spend hours reasoning from.
 */
export function driftWarnings(drifted: readonly DriftedArtifact[]): string[] {
  const [first] = drifted;
  if (first === undefined) return [];
  const shown = drifted.slice(0, REPORT_LIMIT);
  const more = drifted.length > shown.length ? ` and ${drifted.length - shown.length} more` : '';
  return [
    `Artifacts changed on disk since Σ was last written (${readable(first.recordedAt)}): ` +
      shown.map(describeDrift).join(', ') +
      more +
      '. Σ describes a tree that has moved — read the file or run git status before trusting ' +
      'what it says about them.',
  ];
}
