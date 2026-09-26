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
 */

/** Directory of the running module: `<root>/dist` when built, `<root>/src` under tsx. */
const moduleDir = dirname(fileURLToPath(import.meta.url));

/** Package root as seen from the running code; `src/` and `dist/` sit directly under it. */
const packageRoot = resolve(moduleDir, '..');

export interface RuntimeInfo {
  /** Version from package.json, or "unknown" when it cannot be read. */
  version: string;
  /** Directory the running code was loaded from. */
  loadedFrom: string;
  /** True when sources are newer than the loaded build and that build is `dist`. */
  staleBuild: boolean;
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
 * Reads the running build. Never throws: diagnostics must not be able to fail the
 * call they annotate. `staleBuild` is only reported for a `dist` build, because
 * under tsx the sources are what runs and a stale `dist` is irrelevant.
 */
export async function runtimeInfo(): Promise<RuntimeInfo> {
  const loadedFrom = moduleDir;
  const isDist = dirname(loadedFrom) === packageRoot && loadedFrom.endsWith('dist');
  let staleBuild = false;
  if (isDist) {
    const [src, dist] = await Promise.all([
      newestMtime(join(packageRoot, 'src'), '.ts'),
      newestMtime(loadedFrom, '.js'),
    ]);
    staleBuild = src !== null && dist !== null && src > dist;
  }
  return { version: await packageVersion(), loadedFrom, staleBuild };
}

/** One line for tool output: `runtime: state3 0.1.0 (D:\…\dist)`. */
export function formatRuntimeInfo(info: RuntimeInfo): string {
  const stale = info.staleBuild
    ? `${info.loadedFrom} — STALE: src is newer than this build; rebuild and restart the host`
    : info.loadedFrom;
  return `runtime: state3 ${info.version} (${stale})`;
}
