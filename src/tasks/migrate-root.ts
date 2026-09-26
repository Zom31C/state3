import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { STATE_DIRNAME } from '../core/paths.js';
import { STATE_DB_FILENAME } from '../db/database.js';

/**
 * The state directory this project wrote before it was named state3.
 *
 * Kept as a name of its own rather than a string in the migrator because three entry points
 * have to agree on it — the tools, the injection hook and the opencode plugin — and a root
 * that was renamed without its state would look like an empty project to every one of them.
 */
export const LEGACY_STATE_DIRNAME = '.skillstate';

/** Left in the new root so `doctor` and the tools can say where the state came from. */
export const MIGRATION_MARKER = 'MIGRATED-FROM.txt';

/**
 * What an attempt to carry a renamed project's state over did.
 *
 * A refusal is reported rather than acted around: the state root is the one thing a session
 * reads its own progress from, so silently starting an empty root beside a full one would
 * cost the whole history without anything in the turn saying why.
 */
export type RootMigration =
  /** Nothing to do: no legacy sibling, or the new root already holds a database. */
  | { kind: 'none' }
  | { kind: 'migrated'; from: string; to: string; entries: string[] }
  /**
   * The legacy database still has a connection open, so copying it could take a half-written
   * file. This is the normal state of a session that is running while its project is upgraded,
   * and the answer is to migrate after that session ends — not to copy anyway.
   */
  | { kind: 'in-use'; from: string; to: string }
  | { kind: 'failed'; from: string; to: string; reason: string };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The pre-rename root a carry-over would act on, or null when there is nothing to carry over.
 *
 * A probe that changes nothing, which is what lets `doctor` report a pending carry-over instead
 * of performing one: its contract is to answer what a root looks like, not to reshape it.
 * `inUse` says whether the legacy database has a connection open right now, and therefore
 * whether a copy of it could be torn.
 */
export function pendingLegacyRoot(rootDir: string): { from: string; inUse: boolean } | null {
  const to = resolve(rootDir);
  if (basename(to) !== STATE_DIRNAME) return null;
  if (existsSync(join(to, STATE_DB_FILENAME))) return null;

  const from = join(dirname(to), LEGACY_STATE_DIRNAME);
  if (!existsSync(from)) return null;

  // SQLite keeps `-shm` for as long as a connection is open and removes it on a clean close, so
  // its presence means somebody is writing this database right now — in the common case the
  // pre-rename build of this same server, in a session that is still running.
  let inUse = false;
  try {
    inUse = readdirSync(from).includes(`${STATE_DB_FILENAME}-shm`);
  } catch {
    inUse = false;
  }
  return { from, inUse };
}

/**
 * Carries `<project>/.skillstate` over to `<project>/.state3` once, by copying.
 *
 * Three limits keep this from ever destroying state:
 *
 * - it only acts on a conventional project root. A root named by `--root` or
 *   `STATE3_STATE_DIR` is a directory somebody chose deliberately, and its neighbour is none
 *   of this function's business;
 * - it only acts while the new root holds no database, so a second call — and every call after
 *   the first session on the new build — is a no-op, and two roots can never be merged;
 * - it copies and leaves the source in place. The old root may still be open by the session
 *   that is being upgraded, and on Windows a directory with an open file cannot be removed
 *   anyway; deleting it would trade a recoverable duplicate for an unrecoverable loss.
 *
 * Never throws: it is called from read paths, including a hook that runs on every prompt and
 * must cost the turn nothing when it fails.
 */
export function migrateLegacyStateRoot(rootDir: string): RootMigration {
  const to = resolve(rootDir);
  const pending = pendingLegacyRoot(rootDir);
  if (pending === null) return { kind: 'none' };
  const from = pending.from;

  let entries: string[];
  try {
    entries = readdirSync(from);
  } catch (err) {
    return { kind: 'failed', from, to, reason: message(err) };
  }
  if (entries.length === 0) return { kind: 'none' };
  if (pending.inUse) return { kind: 'in-use', from, to };

  try {
    // Taken before the copy: the copy does not touch the source, and this is the state the
    // divergence check below compares against later.
    const source = statOf(join(from, STATE_DB_FILENAME));
    // `force: false` so an entry that already exists in the new root wins. Only reachable when
    // the new root holds something other than a database, and even then the state already
    // written there is the newer claim.
    cpSync(from, to, { recursive: true, force: false });
    writeFileSync(
      join(to, MIGRATION_MARKER),
      [from, new Date().toISOString(), source?.mtimeMs ?? '', source?.size ?? ''].join('\n') + '\n',
    );
  } catch (err) {
    return { kind: 'failed', from, to, reason: message(err) };
  }
  return { kind: 'migrated', from, to, entries };
}

/** mtime and size of a file, or null when it is not there or cannot be read. */
function statOf(file: string): { mtimeMs: number; size: number } | null {
  try {
    const stat = statSync(file);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

/** One line for a tool answer, a hook warning or `doctor`; null when there is nothing to say. */
export function rootMigrationNote(result: RootMigration): string | null {
  switch (result.kind) {
    case 'none':
      return null;
    case 'migrated':
      return (
        `state root migrated from the pre-rename name: ${result.from} -> ${result.to} ` +
        `(${result.entries.length} entry/entries copied). The previous root was left in place; ` +
        'remove it once no session reads it.'
      );
    case 'in-use':
      return (
        `${result.from} still holds an open database connection (state.db-shm), so the state ` +
        `root was NOT carried over to ${result.to}: end the session that predates the rename, ` +
        'then run this again. Copying a database someone is writing could take a half-written Σ.'
      );
    case 'failed':
      return `cannot carry the state root over from ${result.from}: ${result.reason}`;
  }
}

/**
 * What the new root says about where it came from, or null when it was not carried over.
 *
 * `source` is the mtime and size the pre-rename database had at the moment it was copied, and it
 * is null for a root that held only legacy JSON records — there was no database to remember. A
 * marker written before this field existed reads the same way: a line that is not a number is
 * treated as absent rather than as zero, since zero would claim a comparison nobody can make.
 */
export interface CarryOverStamp {
  from: string;
  at: string;
  source: { mtimeMs: number; size: number } | null;
}

export function readMigrationMarker(rootDir: string): CarryOverStamp | null {
  const marker = join(resolve(rootDir), MIGRATION_MARKER);
  if (!existsSync(marker)) return null;
  try {
    const lines = readFileSync(marker, 'utf8').split('\n');
    const from = (lines[0] ?? '').trim();
    if (from === '') return null;
    const mtime = numberOr((lines[2] ?? '').trim());
    const size = numberOr((lines[3] ?? '').trim());
    return {
      from,
      at: (lines[1] ?? '').trim(),
      source: mtime === null || size === null ? null : { mtimeMs: mtime, size },
    };
  } catch {
    return null;
  }
}

function numberOr(text: string): number | null {
  if (text === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/**
 * The pre-rename root this one was carried over from, if it has been written to since.
 *
 * The carry-over copies and deliberately leaves the source in place, which buys a recoverable
 * duplicate at the price of a second root that still looks authoritative. Anything pointed at
 * the old one — a host that kept the pre-rename extension linked, a script with `--root
 * .skillstate`, a second project sharing that build — writes state this root never sees, and
 * both files read as the real one. Nothing merges them, because two histories that diverged
 * have no honest merge; what this does is make the divergence impossible to miss.
 *
 * Null when there is nothing to compare: no marker, a marker without a database stamp, or an old
 * root that has since been deleted.
 *
 * The comparison is mtime and size — one `stat`, no read of the file. A hash would be exact but
 * would tax every session start, and this exists to catch a mistake made over hours, not one made
 * inside a single filesystem tick; that is the known limit, and on a filesystem with coarse
 * timestamps the blind window is as coarse as they are. Size alone would not do either: SQLite
 * reuses pages, so a real write can leave the file exactly as long as it was.
 */
export function divergedSource(
  rootDir: string,
): { from: string; at: string; size: number; nowSize: number } | null {
  const marker = readMigrationMarker(rootDir);
  if (marker === null || marker.source === null) return null;
  const now = statOf(join(marker.from, STATE_DB_FILENAME));
  if (now === null) return null;

  // A millisecond of slack: mtimeMs is a float and a filesystem may round it, and the question is
  // "was it written after the copy", not "are the two floats identical".
  if (now.mtimeMs <= marker.source.mtimeMs + 1 && now.size === marker.source.size) return null;
  return { from: marker.from, at: marker.at, size: marker.source.size, nowSize: now.size };
}

/** The line `doctor` and a session start print when the two roots have diverged. */
export function divergenceNote(diverged: {
  from: string;
  at: string;
  size: number;
  nowSize: number;
}): string {
  return (
    `the pre-rename root ${diverged.from} was written AFTER its state was carried over here ` +
    `(${diverged.at}; state.db ${diverged.size} -> ${diverged.nowSize} bytes). The two roots have ` +
    'diverged and nothing merges them: something is still pointed at the old one. Read both ' +
    'before trusting either, and repoint it at this root.'
  );
}
