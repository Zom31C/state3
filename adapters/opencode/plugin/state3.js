// state3 plugin for opencode.
//
// Injects the external task state (Σ) from `.state3/` into the model context
// so long tasks survive compaction and restarts, and optionally blocks risky tool
// calls while the active task marks its next action as destructive/external.
//
// A root that holds `state.db` is read through the state3 build (`readInjection` in
// `dist/tasks/inject.js`), because reading SQLite needs the driver — the same route the Qwen
// Code hook takes, resolved by `STATE3_HOME` or by walking up from this file. Such a root is
// authoritative: the JSON files beside it are the archive migration left behind, and injecting
// them would show a Σ that is already out of date. The legacy JSON layout is still read here, so
// a project that has not migrated needs no build at all — and only that half is self-contained.
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const STATE_DIRNAME = '.state3';
const STATE_DB_FILENAME = 'state.db';
/**
 * Mirrors LEGACY_STATE_DIRNAME in src/tasks/migrate-root.ts: the state directory of the
 * pre-rename build. Only the name is mirrored, and only to keep the carry-over cheap — the
 * copy itself is done by the build, so the two halves cannot disagree about what it means.
 */
const LEGACY_STATE_DIRNAME = '.skillstate';
/** Proves a directory is a built state3 repository, as far as this plugin is concerned. */
const INJECT_MARKER = join('dist', 'tasks', 'inject.js');
// Above this size Σ stops being an O(1) prompt component, so the agent is told to compress it.
const STATE_SIZE_HINT_CHARS = 4000;
const GUARDED_TOOLS = new Set(['bash', 'write', 'edit', 'patch']);
const RISKY = new Set(['destructive', 'external']);

async function loadActiveTask(stateDir) {
  let names;
  try {
    names = await readdir(stateDir);
  } catch {
    return null;
  }
  const records = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(await readFile(join(stateDir, name), 'utf8'));
      if (raw !== null && typeof raw === 'object' && raw.state !== undefined) records.push(raw);
    } catch {
      // A torn or hand-edited state file must not break the session.
    }
  }
  let best = null;
  for (const record of records) {
    if (record.state?.status !== 'active') continue;
    if (best === null || String(record.updatedAt) > String(best.updatedAt)) best = record;
  }
  return best;
}

/** The state3 build to read a database through, or null when there is none to find. */
function findBuildHome() {
  const fromEnv = process.env.STATE3_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    const candidate = resolve(fromEnv);
    if (existsSync(join(candidate, INJECT_MARKER))) return candidate;
  }
  // Walking up only helps while the plugin runs in place (this repository, its tests, a
  // `--self-test`); a copy inside `.opencode/plugins/` is found through STATE3_HOME alone.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(join(dir, INJECT_MARKER))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Resolved once per process: opencode loads the plugin at startup and then calls the hooks on
// every request, and an import that failed once (a runtime refusing the native driver, say)
// must not be retried — nor silently re-fail — on each of them.
let readerPromise = null;

function reader() {
  readerPromise ??= (async () => {
    const home = findBuildHome();
    if (home === null) return null;
    try {
      return await import(pathToFileURL(join(home, INJECT_MARKER)).href);
    } catch {
      return null;
    }
  })();
  return readerPromise;
}

/**
 * Carries a pre-rename state root over and returns the line worth reporting, or null.
 *
 * Gated on the filesystem rather than on the build, so a project with no state at all does not
 * load dist on every request; the copy, its marker and the "somebody is writing this database"
 * refusal belong to the build, so there is one implementation of the rule.
 */
async function carryOver(stateDir, hasDatabase) {
  if (hasDatabase) return null;
  if (basename(stateDir) !== STATE_DIRNAME) return null;
  if (!existsSync(join(dirname(stateDir), LEGACY_STATE_DIRNAME))) return null;
  const module = await reader();
  if (module === null || typeof module.carryOverStateRoot !== 'function') return null;
  try {
    const note = module.carryOverStateRoot(stateDir);
    return typeof note === 'string' ? note : null;
  } catch {
    return null;
  }
}

/**
 * What one state root holds, ready to inject: `{ head, brief, risk }`, plus `warn` when there
 * is something to say that does not replace the state — a root this plugin cannot read, or the
 * one-time carry-over of a pre-rename root. Null when there is nothing to inject at all.
 *
 * `oncePerSession` asks for the two halves that are worth one look and not a tax on every
 * turn: the knowledge-base map, and the artifacts whose file changed on disk since Σ was
 * written. A session that already saw them gains nothing from reading them again.
 *
 * `warn` is reported rather than swallowed: a root that holds Σ but cannot be read means the
 * model silently stops seeing its own progress, and nothing else in the session would say why.
 */
async function loadContext(stateDir, oncePerSession) {
  const dbPath = join(stateDir, STATE_DB_FILENAME);
  // Ahead of the existence check below, because the carry-over can create the very database
  // that check looks for: without it a renamed project reads as one that never had any state.
  const carried = await carryOver(stateDir, existsSync(dbPath));
  /** Attaches the one-time carry-over line to whatever this root answered, warnings aside. */
  const withNote = (result) =>
    carried === null || result === null || result.warn !== undefined
      ? result
      : { ...result, warn: carried };

  if (existsSync(dbPath)) {
    const module = await reader();
    if (module === null || typeof module.readInjection !== 'function') {
      return {
        warn:
          `${dbPath} needs the state3 build: run "npm run build" in the repository ` +
          'and set STATE3_HOME to it',
      };
    }
    let injection;
    try {
      injection = module.readInjection(stateDir, {
        brief: oncePerSession === true,
        drift: oncePerSession === true,
      });
    } catch (err) {
      return { warn: `cannot read ${dbPath}: ${err?.message ?? String(err)}` };
    }
    if (injection === null || typeof injection !== 'object') return withNote(null);
    if (injection.kind === 'context') {
      return withNote({
        head: typeof injection.task === 'string' ? injection.task : null,
        brief: typeof injection.brief === 'string' ? injection.brief : null,
        risk: typeof injection.risk === 'string' ? injection.risk : null,
      });
    }
    // A build from before the brief and the risk existed answers with Σ alone, under its own
    // kind. Accepted rather than dropped: losing Σ silently is the failure this plugin exists to
    // prevent, and the guard then degrades to not blocking instead of blocking everything.
    if (injection.kind === 'head') {
      return withNote({ head: injection.text, brief: null, risk: null });
    }
    if (injection.kind === 'unreadable') {
      return { warn: `cannot read ${dbPath}: ${String(injection.reason)}` };
    }
    return withNote(null);
  }

  // No database, and the neighbour holding one could not be copied: a reason, not an empty root.
  if (carried !== null) return { warn: carried };

  const record = await loadActiveTask(stateDir);
  if (record === null) return null;
  const compact = JSON.stringify(record.state);
  return {
    head: [
      `Task ${record.id} (${record.state.status}):`,
      compact,
      compact.length > STATE_SIZE_HINT_CHARS
        ? `Σ is ${compact.length} chars — compress it: keep only what future steps need and reduce finished work to its outcome.`
        : '',
    ]
      .filter((line) => line !== '')
      .join('\n'),
    brief: null,
    risk: typeof record.state?.next?.risk === 'string' ? record.state.next.risk : null,
  };
}

function leadFor(purpose) {
  return purpose === 'compacting'
    ? 'The conversation is about to be compacted. The task state below is the authoritative record of progress — keep it in the summary.'
    : 'Authoritative progress record for the active task (the transcript may be incomplete):';
}

/** The two rules a host that injects Σ without the procedure P still has to carry. */
const REMINDERS = [
  'After every meaningful step call the task_patch tool with only the changed fields (null deletes a key; arrays are replaced wholesale, but a path key touches one item — {"plan[1].status":"done"} edits it, {"plan[+]":{…}} appends one, {"verifications[2]":null} removes one, {"plan[id=5].notes":"…"} names a step by its own id — without resending the array; exactly one plan item in_progress, and a finished step whose outcome is already in decisions may be marked {"plan[0].archived":true} to leave this injection).',
  'If next.risk is "destructive" or "external", ask the user for confirmation before executing that action.',
];

function stateBlock(head, purpose) {
  return ['## Active task state (state3)', leadFor(purpose), head, ...REMINDERS]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * The knowledge-base map: one line per page, no bodies.
 *
 * Injected at a session's first request and at compaction, never on every request — the map is
 * worth its tokens once, and at compaction because the summary is what a resumed session starts
 * from. The lead says how old the snapshot is: a page written since then is newer than it.
 */
function briefBlock(brief) {
  return [
    '## Project brief (state3)',
    'What this project has written down for an agent with no context, as one line per page — a snapshot taken when this session started, so a page changed since then is newer than this.',
    brief,
  ].join('\n');
}

// opencode reports worktree "/" for a project that is not a git repository
// (project.id "global"), and Bun counts "/" as absolute — so a candidate must also
// be a real, non-root directory.
function isUsableProjectDir(candidate) {
  return (
    typeof candidate === 'string' &&
    candidate.trim() !== '' &&
    isAbsolute(candidate) &&
    basename(candidate) !== '' &&
    dirname(candidate) !== candidate
  );
}

/**
 * Whether a directory holds this project's state, under either name.
 *
 * The pre-rename one counts too: a project that has not been carried over yet is still the
 * project, and preferring a candidate with no state at all would point every hook at an empty
 * root while the real one sits beside it.
 */
async function hasStateDir(dir) {
  for (const name of [STATE_DIRNAME, LEGACY_STATE_DIRNAME]) {
    try {
      if ((await stat(join(dir, name))).isDirectory()) return true;
    } catch {
      // Not under this name; the next one, or false, is the answer.
    }
  }
  return false;
}

async function resolveProjectDir({ directory, worktree, project }) {
  const explicit = process.env.STATE3_ROOT;
  if (isUsableProjectDir(explicit)) return explicit;
  const candidates = [directory, worktree, project?.worktree, process.cwd()].filter(
    isUsableProjectDir,
  );
  // The directory that actually holds .state3 wins; otherwise take the best guess.
  for (const candidate of candidates) {
    if (await hasStateDir(candidate)) return candidate;
  }
  return candidates[0] ?? process.cwd();
}

// Same escape hatch as the MCP server: an explicit state directory wins over the
// project-dir heuristic, for hosts started outside the project.
function resolveStateDir(projectDir) {
  const fromEnv = process.env.STATE3_STATE_DIR;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv);
  return join(projectDir, STATE_DIRNAME);
}

export const State3 = async ({ directory, worktree, project, client }) => {
  const projectDir = await resolveProjectDir({ directory, worktree, project });
  const stateDir = resolveStateDir(projectDir);
  const guarded = process.env.STATE3_GUARD === '1';

  const log = async (level, message) => {
    try {
      await client.app.log({ body: { service: 'state3', level, message } });
    } catch {
      // Logging must never break a hook.
    }
  };

  /** Sessions that already got the brief: it is a map, not something to pay for every turn. */
  const briefed = new Set();

  /** The blocks to inject for one hook call: Σ always, the brief once per session and at compaction. */
  const readBlocks = async (purpose, input) => {
    try {
      const key = typeof input?.sessionID === 'string' ? input.sessionID : 'default';
      const oncePerSession = purpose === 'compacting' || !briefed.has(key);
      const context = await loadContext(stateDir, oncePerSession);
      if (context === null) return [];
      // A warning no longer ends the read. It used to be the only thing a warning could
      // accompany — an unreadable root, which has no Σ to inject — and the carry-over of a
      // pre-rename root is reported on the very call that first injects from it: dropping the
      // state to announce where it came from would cost more than the announcement is worth.
      if (context.warn !== undefined) await log('warn', context.warn);
      const head = typeof context.head === 'string' ? context.head : null;
      const brief = typeof context.brief === 'string' ? context.brief : null;
      if (brief !== null) briefed.add(key);
      const blocks = [];
      if (head !== null) blocks.push(stateBlock(head, purpose));
      if (brief !== null) blocks.push(briefBlock(brief));
      return blocks;
    } catch (err) {
      await log('debug', `state read failed: ${err?.message ?? String(err)}`);
      return [];
    }
  };

  const hooks = {
    // Documented: extra context strings are appended to the compaction prompt.
    'experimental.session.compacting': async (input, output) => {
      for (const block of await readBlocks('compacting', input)) output.context.push(block);
    },
  };

  // Present in the 1.18.26 plugin typings (not in the public docs): the system
  // prompt of every request, which keeps Σ in context turn by turn.
  if (process.env.STATE3_NO_SYSTEM !== '1') {
    hooks['experimental.chat.system.transform'] = async (input, output) => {
      for (const block of await readBlocks('system', input)) output.system.push(block);
    };
  }

  // Opt-in (STATE3_GUARD=1): documented way to block a tool call is to throw.
  if (guarded) {
    hooks['tool.execute.before'] = async (input) => {
      if (!GUARDED_TOOLS.has(input.tool)) return;
      const context = await loadContext(stateDir, false).catch(() => null);
      const risk = context?.risk;
      if (typeof risk === 'string' && RISKY.has(risk)) {
        throw new Error(
          `state3: the active task marks its next action as "${risk}". ` +
            `Ask the user for confirmation before running "${input.tool}", then set next.risk to "safe" in the task state.`,
        );
      }
    };
  }

  await log(
    'info',
    `loaded (state: ${stateDir}, build: ${findBuildHome() ?? 'none — legacy JSON only'}, ` +
      `system injection: ${process.env.STATE3_NO_SYSTEM !== '1'}, guard: ${guarded})`,
  );
  return hooks;
};

// `node state3.js --self-test [projectDir]` prints what the hooks would inject.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly && process.argv.includes('--self-test')) {
  const at = process.argv.indexOf('--self-test');
  const dir = process.argv[at + 1];
  const projectDir = dir === undefined || dir.startsWith('-') ? process.cwd() : dir;
  const stateDir = resolveStateDir(projectDir);
  // The brief is asked for, so a database root shows both halves a session start would get.
  const context = await loadContext(stateDir, true);
  if (context === null) {
    console.log(`nothing to inject in ${stateDir} (no open task, no pages)`);
  } else {
    if (context.warn !== undefined) console.log(`warning: ${context.warn}`);
    if (context.head != null || context.brief != null) {
      const sections = [
        ['experimental.chat.system.transform', 'system'],
        ['experimental.session.compacting', 'compacting'],
      ];
      for (const [hook, purpose] of sections) {
        console.log(`--- ${hook} ---`);
        if (context.head != null) console.log(stateBlock(context.head, purpose));
        if (context.brief != null) console.log(briefBlock(context.brief));
        console.log('');
      }
    }
  }
}
