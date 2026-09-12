#!/usr/bin/env node
// Launcher for the skillstate MCP server. The extension ships no build of its
// own: it resolves the skillstate repository (SKILLSTATE_HOME, then walking up
// from this file) and runs its compiled server.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SERVER_MARKER, findSkillstateHome } from '../lib/home.mjs';

const home = findSkillstateHome(import.meta.url, SERVER_MARKER);
if (home === null) {
  process.stderr.write(
    `skillstate: cannot find ${SERVER_MARKER}. Run "npm run build" in the skillstate repository ` +
      'and, if this extension lives outside it, set SKILLSTATE_HOME to that repository path.\n',
  );
  process.exit(1);
}

const { main } = await import(pathToFileURL(join(home, SERVER_MARKER)).href);
await main(process.argv.slice(2));
