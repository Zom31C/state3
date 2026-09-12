import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isPlainObject } from '../core/state.js';
import type { StateDict, StateValue } from '../core/types.js';
import { DEFAULT_NOTATION, isNotation } from './notation.js';
import { DEFAULT_SKILL_NAME } from './registry.js';
import type { HistoryEntry } from './store.js';

/** Suffix of the per-task audit sidecar the file-backed store appended to. */
const HISTORY_SUFFIX = '.history.jsonl';

/** One `<id>.json` record, with the fields the old store filled in by default. */
export interface LegacyTaskRecord {
  id: string;
  /** Absolute path of the `<id>.json` file. */
  file: string;
  /** Absolute path of the `<id>.history.jsonl` sidecar, when there is one. */
  historyFile: string | null;
  createdAt: string;
  updatedAt: string;
  skill: string;
  notation: string;
  state: StateDict;
  /** Audit entries read from the sidecar, in file order. */
  history: HistoryEntry[];
}

export interface LegacyUnreadable {
  file: string;
  reason: string;
}

export interface LegacyRoot {
  records: LegacyTaskRecord[];
  /** Files that look like task records but could not be read; never thrown away silently. */
  unreadable: LegacyUnreadable[];
  /**
   * Every legacy file that was read, in a stable order. The migrator moves or deletes
   * exactly this set — it must not touch anything it did not import.
   */
  files: string[];
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Parses one task record, applying the same defaults the file-backed store did. */
function parseRecord(id: string, file: string, content: string): LegacyTaskRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`not valid JSON: ${reason(err)}`);
  }
  if (!isPlainObject(parsed as StateValue)) throw new Error('not a JSON object');

  const record = parsed as {
    createdAt?: unknown;
    updatedAt?: unknown;
    skill?: unknown;
    notation?: unknown;
    state?: unknown;
  };
  const stateValue = record.state as StateValue;
  if (!isPlainObject(stateValue)) {
    throw new Error('has no state object');
  }
  if (typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string') {
    throw new Error('has no createdAt/updatedAt timestamps');
  }

  return {
    id,
    file,
    historyFile: null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    // Records written before skills and notation existed carry neither field.
    skill:
      typeof record.skill === 'string' && record.skill !== '' ? record.skill : DEFAULT_SKILL_NAME,
    notation: isNotation(record.notation) ? record.notation : DEFAULT_NOTATION,
    state: stateValue,
    history: [],
  };
}

/** Reads the audit sidecar, skipping lines that do not parse rather than failing the migration. */
async function parseHistory(file: string): Promise<HistoryEntry[]> {
  let content: string;
  try {
    content = await readFile(file, 'utf-8');
  } catch {
    return [];
  }

  const entries: HistoryEntry[] = [];
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as StateValue;
      if (!isPlainObject(parsed)) continue;
      const entry = parsed as unknown as HistoryEntry;
      if (typeof entry.at !== 'string' || typeof entry.ok !== 'boolean') continue;
      if (!isPlainObject(entry.patch as StateValue)) continue;
      entries.push(entry);
    } catch {
      continue;
    }
  }
  return entries;
}

/**
 * Reads a state root in the layout the file-backed store used: one `<id>.json` per
 * task plus one `<id>.history.jsonl` sidecar.
 *
 * Nothing here throws. A root that cannot be listed, or a record that cannot be
 * parsed, is reported — a migration that aborts on the first damaged file would
 * strand every record after it.
 */
export async function readLegacyRoot(rootDir: string): Promise<LegacyRoot> {
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return { records: [], unreadable: [], files: [] };
  }

  const names = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const present = new Set(names);

  const records: LegacyTaskRecord[] = [];
  const unreadable: LegacyUnreadable[] = [];
  const files: string[] = [];

  for (const name of names.sort()) {
    if (!name.endsWith('.json') || name.endsWith(HISTORY_SUFFIX)) continue;

    const id = name.slice(0, -'.json'.length);
    const file = join(rootDir, name);
    let record: LegacyTaskRecord;
    try {
      record = parseRecord(id, file, await readFile(file, 'utf-8'));
    } catch (err) {
      unreadable.push({ file, reason: reason(err) });
      continue;
    }

    const historyName = `${id}${HISTORY_SUFFIX}`;
    if (present.has(historyName)) {
      const historyFile = join(rootDir, historyName);
      record.historyFile = historyFile;
      record.history = await parseHistory(historyFile);
      files.push(historyFile);
    }

    records.push(record);
    files.push(file);
  }

  return { records, unreadable, files };
}
