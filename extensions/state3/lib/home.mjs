// Resolves the state3 repository this extension runs against: STATE3_HOME first,
// then walking up from the caller. Shared by the server launcher and the inject-state hook
// so both find the same build — or both fail with the same advice.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Proves a directory is a built state3 repository, for the MCP server launcher. */
export const SERVER_MARKER = join('dist', 'mcp', 'server.js');

/** Proves it for the hook, which needs the compiled reader and nothing else. */
export const INJECT_MARKER = join('dist', 'tasks', 'inject.js');

/**
 * The repository root holding `marker`, or null.
 *
 * `callerUrl` is the caller's `import.meta.url`: the walk starts at the file that needs the
 * build, so the extension can be installed anywhere inside the repository, or outside it
 * with STATE3_HOME set.
 */
export function findState3Home(callerUrl, marker = SERVER_MARKER) {
  const fromEnv = process.env.STATE3_HOME;
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    const candidate = resolve(fromEnv);
    if (existsSync(join(candidate, marker))) return candidate;
  }
  let dir = dirname(fileURLToPath(callerUrl));
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(join(dir, marker))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
