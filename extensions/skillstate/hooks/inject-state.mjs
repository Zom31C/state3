#!/usr/bin/env node
// UserPromptSubmit / PreCompact / SessionStart hook: injects the compact active
// task state so the model sees Σ instead of relying on the transcript. When
// SKILLSTATE_PROJECTS declares further roots, their active tasks are injected too,
// so a supervising session sees each worker's Σ without a tool call.
// Never blocks a turn — on any problem it prints nothing and exits 0.
// Standalone by design: the extension can be installed outside the repository, so
// the record shape and the wording of src/tasks/* are mirrored here, not imported.
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const STATE_DIRNAME = '.skillstate';
const KNOWN_EVENTS = new Set(['UserPromptSubmit', 'PreCompact', 'SessionStart']);
// Above this size Σ stops being an O(1) prompt component, so the agent is told to compress it.
const STATE_SIZE_HINT_CHARS = 4000;
// Records written before `skill` and `notation` existed carry neither; the runtime
// reads them as the default skill in plain notation, and so does this hook.
const DEFAULT_SKILL = 'dev-task';
const DEFAULT_NOTATION = 'plain';
const NOTATIONS = ['plain', 'compact'];
// Mirrors notationReminder('compact') in src/tasks/notation.ts.
const COMPACT_NOTATION_REMINDER =
  'Σ uses compact notation: pseudocode, symbols (-> + - = ! ?), one line per entry, paths and commands verbatim.';
// Mirrors PROJECT_NAME in src/tasks/projects.ts: project names are typed by a model.
const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

async function readStdin() {
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return '';
  }
}

/* The task to inject: the most recently updated open one. `active` wins, but a
 * `blocked` task is still open — dropping it would hide Σ in exactly the session
 * that has to resume it after a compaction. Mirrors TaskStore.activeId(). */
function pickActive(records) {
  return (
    pickNewest(records, (status) => status === 'active') ??
    pickNewest(records, (status) => status !== 'done')
  );
}

function pickNewest(records, wanted) {
  let best = null;
  for (const record of records) {
    if (!wanted(taskStatus(record?.state))) continue;
    if (best === null || String(record.updatedAt) > String(best.updatedAt)) best = record;
  }
  return best;
}

async function loadActiveTask(rootDir) {
  let names;
  try {
    names = await readdir(rootDir);
  } catch {
    return null;
  }
  const records = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(await readFile(resolve(rootDir, name), 'utf8'));
      if (raw !== null && typeof raw === 'object' && raw.state !== undefined) records.push(raw);
    } catch {
      // A torn or hand-edited state file must not break the turn.
    }
  }
  return pickActive(records);
}

/** Σ is domain state, so its status is read defensively (mirrors taskStatus). */
function taskStatus(state) {
  return typeof state?.status === 'string' && state.status !== '' ? state.status : 'unknown';
}

function skillOf(record) {
  return typeof record.skill === 'string' && record.skill !== '' ? record.skill : DEFAULT_SKILL;
}

function notationOf(record) {
  return typeof record.notation === 'string' && NOTATIONS.includes(record.notation)
    ? record.notation
    : DEFAULT_NOTATION;
}

function stateSizeHint(compactState) {
  if (compactState.length <= STATE_SIZE_HINT_CHARS) return '';
  return `Σ is ${compactState.length} chars — compress it: keep only what future steps need and reduce finished work to its outcome.`;
}

/** Task header, compact single-line Σ, notation reminder, size hint (mirrors renderTaskHead). */
function taskLines(record) {
  const compactState = JSON.stringify(record.state);
  return [
    `Task ${record.id} [${skillOf(record)}] (${taskStatus(record.state)}):`,
    compactState,
    notationOf(record) === 'compact' ? COMPACT_NOTATION_REMINDER : '',
    stateSizeHint(compactState),
  ].filter((line) => line !== '');
}

/**
 * Mirrors parseProjectsSpec, but leniently: `null` means "skip the projects section
 * entirely". A bad declaration from the environment must never fail a turn.
 * Accepted forms: `name=dir;name2=dir2`, newline-separated pairs, or a JSON object.
 * Relative directories resolve against `cwd`; a root is the state directory itself.
 */
function parseProjectsSpec(spec, cwd) {
  const trimmed = spec.trim();
  if (trimmed === '') return [];

  const pairs = [];
  if (trimmed.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    for (const [name, dir] of Object.entries(parsed)) {
      if (typeof dir !== 'string') return null;
      pairs.push([name, dir]);
    }
  } else {
    for (const part of trimmed.split(/[;\n]/)) {
      if (part.trim() === '') continue;
      const separator = part.indexOf('=');
      if (separator < 1) return null;
      pairs.push([part.slice(0, separator), part.slice(separator + 1)]);
    }
  }

  const entries = [];
  const seen = new Set();
  for (const [name, dir] of pairs) {
    const trimmedName = name.trim();
    if (!PROJECT_NAME.test(trimmedName)) return null;
    if (dir.trim() === '') return null;
    if (seen.has(trimmedName)) return null;
    seen.add(trimmedName);
    entries.push({ name: trimmedName, rootDir: resolve(cwd, dir.trim()) });
  }
  return entries;
}

/** Windows paths differ in case only; a duplicate root would inject Σ twice. */
function sameRoot(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function leadFor(event) {
  if (event === 'PreCompact') {
    return 'The conversation is about to be compacted. The task state below is the authoritative record of progress — keep it in the summary.';
  }
  if (event === 'SessionStart') {
    return 'The session started, resumed, or was compacted. Resume from the task state below; call task_show for the full procedure.';
  }
  return 'Authoritative progress record for the active task (the transcript may be incomplete):';
}

// `--self-test [dir]` skips the stdin event so the hook can be run by hand.
const selfTestAt = process.argv.indexOf('--self-test');
let event = {};
if (selfTestAt !== -1) {
  const dir = process.argv[selfTestAt + 1];
  event = {
    cwd: dir === undefined ? process.cwd() : resolve(dir),
    hook_event_name: 'UserPromptSubmit',
  };
} else {
  try {
    event = JSON.parse(await readStdin());
  } catch {
    event = {};
  }
}

const projectDir = typeof event.cwd === 'string' && event.cwd !== '' ? event.cwd : process.cwd();
// The host reports its own startup directory as `cwd`, which is not necessarily the
// project, so an explicit override wins for the primary root.
const envStateDir = process.env.SKILLSTATE_STATE_DIR;
const stateDir =
  typeof envStateDir === 'string' && envStateDir.trim() !== ''
    ? resolve(envStateDir)
    : resolve(projectDir, STATE_DIRNAME);
const eventName = KNOWN_EVENTS.has(event.hook_event_name)
  ? event.hook_event_name
  : 'UserPromptSubmit';

const sections = [];

let primary = null;
try {
  primary = await loadActiveTask(stateDir);
} catch {
  primary = null;
}
if (primary !== null) {
  sections.push(
    [
      '## Active task state (skillstate)',
      leadFor(eventName),
      ...taskLines(primary),
      'After every meaningful step call task_patch with only the changed fields (null deletes a key; arrays are replaced wholesale, but a path key touches one item — {"plan[1].status":"done"} edits it, {"plan[+]":{…}} appends one — without resending the array; exactly one plan item in_progress).',
      'If next.risk is "destructive" or "external", ask the user for confirmation before executing that action.',
    ].join('\n'),
  );
}

// Supervised projects: their Σ is injected as well, so the supervising session does
// not have to spend a tool call per worker to see progress. One bad project (unreadable
// root, no active task, duplicate of the primary root) is skipped without hiding the rest.
const projectsSpec = process.env.SKILLSTATE_PROJECTS;
if (typeof projectsSpec === 'string' && projectsSpec.trim() !== '') {
  let entries = null;
  try {
    entries = parseProjectsSpec(projectsSpec, projectDir);
  } catch {
    entries = null;
  }
  if (entries !== null && entries.length > 0) {
    const loaded = await Promise.all(
      entries.map(async (entry) => {
        try {
          if (sameRoot(entry.rootDir, stateDir)) return null;
          const record = await loadActiveTask(entry.rootDir);
          return record === null ? null : { entry, record };
        } catch {
          return null;
        }
      }),
    );
    const subsections = loaded
      .filter((item) => item !== null)
      .map((item) => [`### ${item.entry.name} — ${item.entry.rootDir}`, ...taskLines(item.record)]);
    if (subsections.length > 0) {
      sections.push(
        [
          '## Supervised projects (skillstate)',
          ...subsections.flat(),
          'Patch these with the project argument: task_patch {"project":"<name>", …}.',
        ].join('\n'),
      );
    }
  }
}

if (sections.length === 0) process.exit(0);

process.stdout.write(
  `${JSON.stringify({
    hookSpecificOutput: { hookEventName: eventName, additionalContext: sections.join('\n\n') },
  })}\n`,
);
