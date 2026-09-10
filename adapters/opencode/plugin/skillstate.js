// skillstate plugin for opencode.
//
// Injects the external task state (Σ) from `.skillstate/` into the model context
// so long tasks survive compaction and restarts, and optionally blocks risky tool
// calls while the active task marks its next action as destructive/external.
//
// Self-contained on purpose: the file is copied into `.opencode/plugins/`, so it
// must not import anything from the skillstate repository.
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const STATE_DIRNAME = '.skillstate';
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

function stateBlock(record, purpose) {
  const compact = JSON.stringify(record.state);
  const lead =
    purpose === 'compacting'
      ? 'The conversation is about to be compacted. The task state below is the authoritative record of progress — keep it in the summary.'
      : 'Authoritative progress record for the active task (the transcript may be incomplete):';
  return [
    '## Active task state (skillstate)',
    lead,
    `Task ${record.id} (${record.state.status}):`,
    compact,
    compact.length > STATE_SIZE_HINT_CHARS
      ? `Σ is ${compact.length} chars — compress it: keep only what future steps need and reduce finished work to its outcome.`
      : '',
    'After every meaningful step call the task_patch tool with only the changed fields (null deletes a key; arrays are replaced wholesale; exactly one plan item in_progress).',
    'If next.risk is "destructive" or "external", ask the user for confirmation before executing that action.',
  ]
    .filter((line) => line !== '')
    .join('\n');
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

async function hasStateDir(dir) {
  try {
    return (await stat(join(dir, STATE_DIRNAME))).isDirectory();
  } catch {
    return false;
  }
}

async function resolveProjectDir({ directory, worktree, project }) {
  const explicit = process.env.SKILLSTATE_ROOT;
  if (isUsableProjectDir(explicit)) return explicit;
  const candidates = [directory, worktree, project?.worktree, process.cwd()].filter(
    isUsableProjectDir,
  );
  // The directory that actually holds .skillstate wins; otherwise take the best guess.
  for (const candidate of candidates) {
    if (await hasStateDir(candidate)) return candidate;
  }
  return candidates[0] ?? process.cwd();
}

// Same escape hatch as the MCP server: an explicit state directory wins over the
// project-dir heuristic, for hosts started outside the project.
function resolveStateDir(projectDir) {
  const fromEnv = process.env.SKILLSTATE_STATE_DIR;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv);
  return join(projectDir, STATE_DIRNAME);
}

export const Skillstate = async ({ directory, worktree, project, client }) => {
  const projectDir = await resolveProjectDir({ directory, worktree, project });
  const stateDir = resolveStateDir(projectDir);
  const guarded = process.env.SKILLSTATE_GUARD === '1';

  const log = async (level, message) => {
    try {
      await client.app.log({ body: { service: 'skillstate', level, message } });
    } catch {
      // Logging must never break a hook.
    }
  };

  const readBlock = async (purpose) => {
    try {
      const record = await loadActiveTask(stateDir);
      return record === null ? null : stateBlock(record, purpose);
    } catch (err) {
      await log('debug', `state read failed: ${err?.message ?? String(err)}`);
      return null;
    }
  };

  const hooks = {
    // Documented: extra context strings are appended to the compaction prompt.
    'experimental.session.compacting': async (_input, output) => {
      const block = await readBlock('compacting');
      if (block !== null) output.context.push(block);
    },
  };

  // Present in the 1.18.26 plugin typings (not in the public docs): the system
  // prompt of every request, which keeps Σ in context turn by turn.
  if (process.env.SKILLSTATE_NO_SYSTEM !== '1') {
    hooks['experimental.chat.system.transform'] = async (_input, output) => {
      const block = await readBlock('system');
      if (block !== null) output.system.push(block);
    };
  }

  // Opt-in (SKILLSTATE_GUARD=1): documented way to block a tool call is to throw.
  if (guarded) {
    hooks['tool.execute.before'] = async (input) => {
      if (!GUARDED_TOOLS.has(input.tool)) return;
      const record = await loadActiveTask(stateDir).catch(() => null);
      const risk = record?.state?.next?.risk;
      if (typeof risk === 'string' && RISKY.has(risk)) {
        throw new Error(
          `skillstate: the active task marks its next action as "${risk}". ` +
            `Ask the user for confirmation before running "${input.tool}", then set next.risk to "safe" in the task state.`,
        );
      }
    };
  }

  await log(
    'info',
    `loaded (state: ${stateDir}, system injection: ${process.env.SKILLSTATE_NO_SYSTEM !== '1'}, guard: ${guarded})`,
  );
  return hooks;
};

// `node skillstate.js --self-test [projectDir]` prints what the hooks would inject.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly && process.argv.includes('--self-test')) {
  const at = process.argv.indexOf('--self-test');
  const dir = process.argv[at + 1];
  const projectDir = dir === undefined || dir.startsWith('-') ? process.cwd() : dir;
  const stateDir = resolveStateDir(projectDir);
  const record = await loadActiveTask(stateDir);
  if (record === null) {
    console.log(`no active task in ${stateDir}`);
  } else {
    console.log('--- experimental.chat.system.transform ---');
    console.log(stateBlock(record, 'system'));
    console.log('\n--- experimental.session.compacting ---');
    console.log(stateBlock(record, 'compacting'));
  }
}
