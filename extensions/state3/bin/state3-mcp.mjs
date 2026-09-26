#!/usr/bin/env node
// Launcher for the state3 MCP server. The extension ships no build of its
// own: it resolves the state3 repository (STATE3_HOME, then walking up
// from this file) and runs its compiled server.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SERVER_MARKER, findState3Home } from '../lib/home.mjs';

const home = findState3Home(import.meta.url, SERVER_MARKER);
if (home === null) {
  process.stderr.write(
    `state3: cannot find ${SERVER_MARKER}. Run "npm run build" in the state3 repository ` +
      'and, if this extension lives outside it, set STATE3_HOME to that repository path.\n',
  );
  process.exit(1);
}

const { main } = await import(pathToFileURL(join(home, SERVER_MARKER)).href);
await main(process.argv.slice(2));
