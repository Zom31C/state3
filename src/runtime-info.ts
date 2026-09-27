import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Runtime diagnostics: which build is actually answering.
 *
 * A host keeps the MCP server it started, so editing sources does not change the
 * code that runs until the build is redone and the host restarted. The failure is
 * silent and confusing — a feature that exists in `src` behaves as if it did not —
 * so the tools report the version, the directory the code was loaded from, and
 * whether the sources are newer than that build.
 *
 * Two stalenesses, because they are fixed by two different things. `staleBuild` says the build
 * lags behind the sources, and a rebuild closes it. `rebuiltAt` says the opposite: the build was
 * redone *under* a process that is still running the previous one, which no rebuild fixes and
 * only a restart of the host does. The second is the one that stayed invisible — after
 * `npm run build` a live server picked the frontier by an older rule than the hook that reloads
 * `dist` on every event, so the injection named one task and `task_show` answered with another.
 */

/** Directory of the running module: `<root>/dist` when built, `<root>/src` under tsx. */
const moduleDir = dirname(fileURLToPath(import.meta.url));

/** Package root as seen from the running code; `src/` and `dist/` sit directly under it. */
const packageRoot = resolve(moduleDir, '..');

/**
 * When this process started, from its own clock and uptime: the code it answers with was loaded
 * then, and a build written to disk after that moment is one it will never see.
 */
const processStartedAt = Date.now() - process.uptime() * 1000;

export interface RuntimeInfo {
  /** Version from package.json, or "unknown" when it cannot be read. */
  version: string;
  /** Directory the running code was loaded from. */
  loadedFrom: string;
  /** True when sources are newer than the loaded build and that build is `dist`. */
  staleBuild: boolean;
  /**
   * When the build on disk was written, if that is after this process started and so is not the
   * build answering; null while this process runs the newest build there is.
   */
  rebuiltAt: string | null;
}

async function packageVersion(): Promise<string> {
  try {
    const raw = await readFile(join(packageRoot, 'package.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Newest mtime among files with `suffix` under `dir`, or null when there are none. */
async function newestMtime(dir: string, suffix: string): Promise<number | null> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let newest: number | null = null;
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await newestMtime(full, suffix);
      if (nested !== null && (newest === null || nested > newest)) newest = nested;
      continue;
    }
    if (!entry.name.endsWith(suffix)) continue;
    try {
      const info = await stat(full);
      if (newest === null || info.mtimeMs > newest) newest = info.mtimeMs;
    } catch {
      // A file that vanished mid-scan must not break the report.
    }
  }
  return newest;
}

/**
 * The moment the build on disk replaced the one this process loaded, or null while it has not.
 *
 * Split out because the rule is one comparison of two numbers, and reaching it through
 * `runtimeInfo` would mean moving real files and starting a real process — a test of the
 * filesystem's clock rather than of the rule.
 */
export function rebuiltAfterStart(
  startedAt: number,
  treeNewestMtime: number | null,
): string | null {
  if (treeNewestMtime === null || treeNewestMtime <= startedAt) return null;
  return new Date(treeNewestMtime).toISOString();
}

/**
 * Reads the running build. Never throws: diagnostics must not be able to fail the
 * call they annotate. Both flags are reported only for a `dist` build: under tsx the
 * sources are what runs, so a stale `dist` says nothing, and a tsx process here is a
 * one-shot CLI that is gone before the sources move again.
 */
export async function runtimeInfo(): Promise<RuntimeInfo> {
  const loadedFrom = moduleDir;
  const isDist = dirname(loadedFrom) === packageRoot && loadedFrom.endsWith('dist');
  let staleBuild = false;
  let rebuiltAt: string | null = null;
  if (isDist) {
    const [src, dist] = await Promise.all([
      newestMtime(join(packageRoot, 'src'), '.ts'),
      newestMtime(loadedFrom, '.js'),
    ]);
    staleBuild = src !== null && dist !== null && src > dist;
    // The scan is already paid for `staleBuild`, so learning that the process trails the disk
    // costs nothing on top of learning that the disk trails the sources.
    rebuiltAt = rebuiltAfterStart(processStartedAt, dist);
  }
  return { version: await packageVersion(), loadedFrom, staleBuild, rebuiltAt };
}

/**
 * One line for tool output: `runtime: state3 0.1.0 (D:\…\dist)`.
 *
 * `STALE` wins when both hold: the rebuild it asks for ends with the restart the other flag asks
 * for, and one line saying "restart" twice teaches a reader to skip it.
 */
export function formatRuntimeInfo(info: RuntimeInfo): string {
  let build = info.loadedFrom;
  if (info.staleBuild) {
    build = `${info.loadedFrom} — STALE: src is newer than this build; rebuild and restart the host`;
  } else if (info.rebuiltAt !== null) {
    build =
      `${info.loadedFrom} — RESTART: this build was replaced on disk at ${info.rebuiltAt}, ` +
      'after the process answering had started; restart the host, which until then runs code ' +
      'older than the repository';
  }
  return `runtime: state3 ${info.version} (${build})`;
}
