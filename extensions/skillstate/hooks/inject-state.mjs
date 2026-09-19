#!/usr/bin/env node
// UserPromptSubmit / PreCompact / SessionStart / SubagentStart hook: injects the compact
// active task state so the model sees Σ instead of relying on the transcript. When
// SKILLSTATE_PROJECTS declares further roots, their active tasks are injected too,
// so a supervising session sees each worker's Σ without a tool call.
// On SessionStart it also injects the project brief — the knowledge base as one line per
// page — because that is the one moment the transcript holds nothing to orient by. On every
// other event the brief stays out: the session has already seen it, and paying for it again
// on each prompt would cost more than the map is worth.
// On SubagentStart it injects neither Σ nor the brief but a few lines of orientation instead:
// a delegated agent begins with no transcript and usually no skillstate tools, so it needs to
// know that a task exists and which step is in flight — not the whole state, which it would
// pay for again on every one of its own turns. SKILLSTATE_SUBAGENT_STATE=off leaves it silent.
// Never blocks a turn — on any problem it prints nothing and exits 0.
// Σ lives in the project's state.db, and reading SQLite needs the driver, so a root that
// has one is read through the repository build (dist/tasks/inject.js). The legacy JSON
// layout is still read here: that keeps an un-migrated root working, and keeps the hook
// usable by an extension installed without the repository. Only that half is standalone,
// mirroring the record shape and the wording of src/tasks/* instead of importing them.
// A legacy root has no database and therefore no pages, so it never has a brief to inject.
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { INJECT_MARKER, findSkillstateHome } from '../lib/home.mjs';

const STATE_DIRNAME = '.skillstate';
/** Mirrors STATE_DB_FILENAME in src/db/database.ts. */
const STATE_DB_FILENAME = 'state.db';
const KNOWN_EVENTS = new Set(['UserPromptSubmit', 'PreCompact', 'SessionStart', 'SubagentStart']);
// Above this size Σ stops being an O(1) prompt component, so the agent is told to compress it.
const STATE_SIZE_HINT_CHARS = 4000;
// Set to `off` to leave a delegated subagent without orientation: the right choice for an agent
// whose work has nothing to do with the task in flight, and whose every turn would otherwise
// carry these lines.
const SUBAGENT_STATE_ENV = 'SKILLSTATE_SUBAGENT_STATE';
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

/** A trimmed string, or null: Σ is domain state, so every field is read defensively. */
function trimmed(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === '' ? null : text;
}

/** The one plan item in flight, notes included — a subagent must not redo it. */
function inProgress(plan) {
  if (!Array.isArray(plan)) return null;
  for (const item of plan) {
    if (item === null || typeof item !== 'object' || item.status !== 'in_progress') continue;
    const what = trimmed(item.task);
    if (what === null) continue;
    const notes = trimmed(item.notes);
    return notes === null ? what : `${what} — ${notes}`;
  }
  return null;
}

/**
 * Orientation for a delegated subagent (mirrors renderTaskBrief in src/tasks/render.ts): the
 * task, its goal, the step in flight, what comes next, what blocks. Not Σ — a subagent carries
 * its prompt on every one of its own turns, and the full state together with the procedure of
 * its skill is one task_show away for the rare agent that has the tool.
 */
function subagentBriefLines(record) {
  const state = record.state !== null && typeof record.state === 'object' ? record.state : {};
  const goal = trimmed(state.goal);
  const current = inProgress(state.plan);
  const next = state.next !== null && typeof state.next === 'object' ? state.next : {};
  const action = trimmed(next.action);
  const risk = trimmed(next.risk);
  const blockers = Array.isArray(state.blockers)
    ? state.blockers
        .map(trimmed)
        .filter((line) => line !== null)
        .join('; ')
    : '';
  return [
    `Task ${record.id} [${skillOf(record)}] (${taskStatus(state)})`,
    goal === null ? '' : `goal: ${goal}`,
    current === null ? '' : `in flight: ${current}`,
    action === null ? '' : `next: ${action}${risk === null ? '' : ` [risk: ${risk}]`}`,
    blockers === '' ? '' : `blocked: ${blockers}`,
  ].filter((line) => line !== '');
}

/** The compiled reader, or null when this extension cannot reach a build. Resolved once. */
let injectModule;
async function reader() {
  if (injectModule !== undefined) return injectModule;
  const home = findSkillstateHome(import.meta.url, INJECT_MARKER);
  if (home === null) {
    injectModule = null;
  } else {
    try {
      injectModule = await import(pathToFileURL(join(home, INJECT_MARKER)).href);
    } catch {
      // A build that will not load is the same, from here, as no build at all.
      injectModule = null;
    }
  }
  return injectModule;
}

/**
 * What to inject for one state root, or null when there is nothing to inject.
 *
 * A root with a database is read through the build and is authoritative: migration archives
 * the JSON it replaced, so falling back to those files would inject a state that is already
 * out of date. `warn` is a line for stderr — a root that holds Σ but cannot be read must not
 * fail silently, because the model would simply stop seeing its own progress and nothing in
 * the turn would say why.
 *
 * `brief` asks for the knowledge-base brief as well, which only a session start does;
 * `subagent` asks for the delegated-agent orientation instead of Σ. A build from before the
 * subagent brief existed ignores that option and answers with Σ: costlier, but never silent.
 */
async function injectionFor(rootDir, { brief = false, subagent = false } = {}) {
  const dbPath = join(rootDir, STATE_DB_FILENAME);
  if (existsSync(dbPath)) {
    const module = await reader();
    if (module === null || typeof module.readInjection !== 'function') {
      return {
        warn:
          `${dbPath} needs the skillstate build: run "npm run build" in the repository, ` +
          'or set SKILLSTATE_HOME to it',
      };
    }
    let injection;
    try {
      injection = module.readInjection(rootDir, { brief, subagent });
    } catch (err) {
      return { warn: `cannot read ${dbPath}: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (injection === null || typeof injection !== 'object') return null;
    if (injection.kind === 'context') {
      return {
        task: typeof injection.task === 'string' ? injection.task : null,
        brief: typeof injection.brief === 'string' ? injection.brief : null,
      };
    }
    // A build from before the brief existed answers with Σ alone under its own kind. Accepted
    // rather than dropped: an extension and a SKILLSTATE_HOME build are not upgraded together,
    // and losing Σ silently is the one failure this hook must not have.
    if (injection.kind === 'head') return { task: injection.text, brief: null };
    if (injection.kind === 'unreadable') {
      return { warn: `cannot read ${dbPath}: ${String(injection.reason)}` };
    }
    return null;
  }

  const record = await loadActiveTask(rootDir);
  if (record === null) return null;
  const lines = subagent ? subagentBriefLines(record) : taskLines(record);
  return { task: lines.join('\n'), brief: null };
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
  if (event === 'SubagentStart') {
    return 'You have been delegated a subtask and start with no conversation history. This is the task in flight in the project you were launched in: do not open a second one, and do not redo the step already in flight. task_show returns the full state and the procedure, if you have that tool.';
  }
  return 'Authoritative progress record for the active task (the transcript may be incomplete):';
}

/**
 * The brief, as its own section. The lead says what the text is and how old it is: a page
 * written later in the session is newer than this snapshot, and an agent that treats the
 * brief as live would argue with the project's own database.
 */
function briefSection(brief) {
  return [
    '## Project brief (skillstate)',
    'What this project has written down for an agent with no context, as one line per page — a snapshot taken at session start, so a page changed since then is newer than this.',
    brief,
  ].join('\n');
}

// `--self-test [dir] [event]` skips the stdin event so the hook can be run by hand. An unknown
// event name is safe here: it falls through to UserPromptSubmit exactly as a bad event would.
const selfTestAt = process.argv.indexOf('--self-test');
let event = {};
if (selfTestAt !== -1) {
  const dir = process.argv[selfTestAt + 1];
  const name = process.argv[selfTestAt + 2];
  event = {
    cwd: dir === undefined ? process.cwd() : resolve(dir),
    hook_event_name: name === undefined ? 'UserPromptSubmit' : name,
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
const isSubagentStart = eventName === 'SubagentStart';

// An agent delegated for work unrelated to the task in flight gains nothing from these lines
// and pays for them on every turn, so the orientation can be switched off per environment.
const subagentState = process.env[SUBAGENT_STATE_ENV];
if (
  isSubagentStart &&
  typeof subagentState === 'string' &&
  subagentState.trim().toLowerCase() === 'off'
) {
  process.exit(0);
}

const sections = [];
/** One line per root that holds Σ but could not be read. Goes to stderr, never to stdout. */
const warnings = [];

// This root only, and on a session start only. A supervising session gets each worker's Σ
// injected, but not each worker's knowledge base: that would multiply the brief by the number
// of projects, and project_brief {"project":"<name>"} is one call away when it is really needed.
const wantBrief = eventName === 'SessionStart';

let primary = null;
try {
  primary = await injectionFor(stateDir, { brief: wantBrief, subagent: isSubagentStart });
} catch {
  primary = null;
}
if (primary !== null && primary.warn !== undefined) warnings.push(primary.warn);
if (primary !== null && typeof primary.task === 'string') {
  sections.push(
    [
      '## Active task state (skillstate)',
      leadFor(eventName),
      primary.task,
      // A subagent is told to report rather than to patch: it usually has no skillstate tools,
      // and two agents patching one Σ is how a plan item gets marked done twice.
      ...(isSubagentStart
        ? [
            'Report what you changed and what you actually verified — the session that delegated you owns Σ and records it there. Patch the state yourself only if you were given the skillstate tools.',
            'If next.risk is "destructive" or "external", stop and report it: asking the user is the orchestrator\'s job, not yours.',
          ]
        : [
            'After every meaningful step call task_patch with only the changed fields (null deletes a key; arrays are replaced wholesale, but a path key touches one item — {"plan[1].status":"done"} edits it, {"plan[+]":{…}} appends one, {"verifications[2]":null} removes one, {"plan[id=5].notes":"…"} names a step by its own id — without resending the array; exactly one plan item in_progress, and a finished step whose outcome is already in decisions may be marked {"plan[0].archived":true} to leave this injection).',
            'If next.risk is "destructive" or "external", ask the user for confirmation before executing that action.',
          ]),
    ].join('\n'),
  );
}
// Σ first, the brief second: a resumed session is here to continue, and the map is what it
// reads once it knows what it is continuing.
if (primary !== null && typeof primary.brief === 'string') {
  sections.push(briefSection(primary.brief));
}

// Supervised projects: their Σ is injected as well, so the supervising session does
// not have to spend a tool call per worker to see progress. One bad project (unreadable
// root, no active task, duplicate of the primary root) is skipped without hiding the rest.
// Not for a subagent: it was delegated inside this project, and every worker's Σ on top of its
// own orientation is context it cannot act on. A supervising session still gets them all.
const projectsSpec = process.env.SKILLSTATE_PROJECTS;
if (!isSubagentStart && typeof projectsSpec === 'string' && projectsSpec.trim() !== '') {
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
          // No brief for a supervised root: see wantBrief above.
          const injection = await injectionFor(entry.rootDir);
          if (injection === null) return null;
          if (injection.warn !== undefined) {
            warnings.push(injection.warn);
            return null;
          }
          return typeof injection.task === 'string' ? { entry, text: injection.task } : null;
        } catch {
          return null;
        }
      }),
    );
    const subsections = loaded
      .filter((item) => item !== null)
      .map((item) => [`### ${item.entry.name} — ${item.entry.rootDir}`, item.text]);
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

for (const line of warnings) process.stderr.write(`skillstate: ${line}\n`);

if (sections.length > 0) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: eventName, additionalContext: sections.join('\n\n') },
    })}\n`,
  );
}

// Exit explicitly: the host may leave stdin open, and a hook that waits for it runs into its
// timeout instead of letting the turn proceed. Skipped when a warning was just written —
// process.exit() can drop a pending stderr write, and that line is the only clue a user gets
// as to why Σ stopped being injected.
if (warnings.length === 0) process.exit(0);
