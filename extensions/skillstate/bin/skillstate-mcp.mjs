#!/usr/bin/env node
// Launcher for the skillstate MCP server. The extension ships no build of its
// own: it resolves the skillstate repository (SKILLSTATE_HOME, then walking up
// from this file) and runs its compiled server.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SERVER_RELATIVE = join('dist', 'mcp', 'server.js');

function findHome() {
  const fromEnv = process.env.SKILLSTATE_HOME;
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    const candidate = resolve(fromEnv);
    if (existsSync(join(candidate, SERVER_RELATIVE))) return candidate;
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(join(dir, SERVER_RELATIVE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const home = findHome();
if (home === null) {
  process.stderr.write(
    `skillstate: cannot find ${SERVER_RELATIVE}. Run "npm run build" in the skillstate repository ` +
      'and, if this extension lives outside it, set SKILLSTATE_HOME to that repository path.\n',
  );
  process.exit(1);
}

const { main } = await import(pathToFileURL(join(home, SERVER_RELATIVE)).href);
await main(process.argv.slice(2));
