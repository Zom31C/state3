# Working with skillState in this project

Copy this file to the root of your project as `AGENTS.md` (or merge it into the one you
have), then fill in the last section.

This project keeps its progress and its documentation **outside the conversation**: an
external task state Σ and a project knowledge base, both in `.skillstate/state.db` (SQLite),
written through the MCP server `skillstate` and validated on every write. The transcript is
lossy — it gets compacted, and a new session starts empty. Σ and the pages are not.

Two consequences you have to act on:

1. **Your progress is real only once it is in Σ.** Work that was not patched in does not
   survive the next compaction, and the next session redoes it.
2. **What you learn is real only once it is a page.** A decision, a gotcha, the reason a
   design looks odd — left in the transcript, it is gone, and the next session asks the user
   the same question again.

The full procedure P of your task's skill comes back from `task_show`. This file is the
habits, deliberately not a copy of P — and it is loaded into every session, so every line
here costs tokens on every turn. Keep additions to it short.

## Tools

Nine, from the MCP server `skillstate`. Hosts prefix them: `mcp__skillstate__task_show` in
Qwen Code, `skillstate_task_show` in opencode.

| Tool            | What it is for                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `task_start`    | open Σ for a job: goal, ordered plan, `skill`, `notation`                                      |
| `task_show`     | Σ **plus the procedure P** of its skill — the first call after a restart                       |
| `task_patch`    | the only way Σ changes; send only what changed                                                 |
| `task_finish`   | close the task with a summary of the outcome                                                   |
| `task_list`     | tasks, the skills this runtime has, the declared projects, the runtime line                    |
| `task_history`  | audit trail, including rejected patches and why                                                |
| `project_brief` | L0 map of the project: one line per page, no bodies, inside a fixed budget                     |
| `page`          | the knowledge base, chosen by `op`: `get` `put` `list` `delete` `init` `link` `unlink` `links` |
| `search`        | full text over tasks and pages, best match first, hits with short snippets                     |

Every tool takes an optional `project` — the name of another state root the user declared
(`SKILLSTATE_PROJECTS`) — which is how a supervising session reads and patches a worker's Σ
in a different directory. Only declared roots are reachable, and an unknown name is an error
that lists them: never reach for a directory that was not declared, ask the user to declare
it.

Tools name the state root they used (`Started task <id> [<skill>] at <path>`,
`no tasks (state root: …)`). **If that root is not this project, stop and tell the user.**
The host starts the server in its own launch directory, which is not necessarily the
project; `SKILLSTATE_STATE_DIR` pins the right one. Do not create or patch tasks in a
directory you did not expect.

## Starting a session (cold start)

Read cheap first, and stop as soon as you know enough to act:

1. The injected blocks — `## Active task state (skillstate)`, `## Project brief (skillstate)`,
   `## Supervised projects (skillstate)` — are already in your context. Read them before
   spending a tool call.
2. `project_brief` when no brief was injected, or after a long session: the injection is a
   session-start snapshot, so a page written since then is newer than the brief.
3. `task_show` when a task is in flight. It returns Σ **and P**; trust it over your
   recollection of the conversation.
4. `page {"op":"get","id":"project"}`, then `"user-intent"` — what this project is, how it is
   built and tested, what the user wants and what is out of scope.
5. `search {"query":"…"}` before reading a file end to end, and before asking the user
   something this project may already have written down.

In a project with no pages, `page {"op":"init"}` scaffolds the three reserved ones
(`project`, `user-intent`, `onboarding`) as templates marked `stale`. Replace their `<…>`
placeholders and set `status` to `current` in the same `put`: a template left stale is the one
failure `init` cannot prevent by itself, and in the brief it reads `- project (stale):
TEMPLATE …`. `init` never overwrites a page that exists — rewriting one is an explicit `put`.

Do not re-derive what Σ already states. If Σ lists an artifact, it exists; if it records a
verification as `pass`, that command was run and its output seen. Re-checking costs a tool
call and a page of output — do it when you are about to build on the result, not to confirm
the state you were just given.

## Opening a task

Call `task_start` before the first edit whenever the job is more than a handful of steps:
refactors, migrations, multi-file features, investigations, resuming earlier work — and any
bug fix that needs reproduce → fix → verify.

- `goal`: one sentence, the outcome, not the activity.
- `plan`: ordered strings, one per step. Exactly one item is `in_progress` at any time.
- `skill`: `dev-task` (default) for work you do here; `supervise-task` for reviewing another
  agent's work — it has no `plan` array, so start it with the goal and fill `spec`, `worker`
  and `rounds` by patching.
- `notation`: `compact` when every injected character counts (a small local model, a very
  long task) — Σ values become one-line pseudocode, symbols instead of prose, paths and
  commands verbatim, and never a compressed-away constraint or failing command.

One open task per project. If one already exists, `task_list` then `task_show` — do not start
a second. A task in `done` cannot be reopened (the guard refuses it): start a new one.

## Keeping Σ current

Patch after **every meaningful step** — a file written, a check run, a decision made, a
blocker found. Not at the end: the end is exactly when the transcript gets compacted.

- Send only the fields that changed. Nested objects merge recursively, scalars replace,
  `null` deletes a key (`{"artifacts":{"src/old.ts":null}}`), arrays are replaced wholesale.
  Object keys are addressed nested like that, never as a dotted top-level key:
  `{"artifacts.src/old.ts":null}` names no field and is rejected as `unknown-key`.
- Cheaper for arrays — a **path key** touches one element: `{"plan[1].status":"done"}`,
  `{"plan[0].notes":"reopened: the fix regressed"}`, `{"decisions[+]":"…"}`,
  `{"rounds[0].verdict":"accepted"}`, and `{"plan[+]":{…}}` appends. Indexes count from 0 and
  the form works for any array field of your skill's Σ. Path keys are expanded before the
  guard and the schema run, so they cannot bypass a domain rule; they cannot remove an element
  (send the array without it); and one field cannot be sent both wholesale and by path in the
  same patch.
- `plan` — finished item `done`, next item `in_progress`, concrete step in `next.action`: one
  patch. Reopening a `done` item needs the reason in its `notes`.
- `artifacts` — one line per touched file or resource, saying what it is **now**. Delete stale
  entries with `null`; merging alone never shrinks Σ.
- `verifications` — the literal command and its **real** status (`evidence` in
  `supervise-task`). Never `pass` without output you actually saw; a check you did not run is
  recorded as not run.
- `decisions` — the choices later steps must respect, one line each, with the reason.
- `blockers` plus `status:"blocked"` when progress stops; clear them when it resumes.
  `blocked` with no blocker is refused.
- `next.action` — specific enough that a session with no transcript can continue from it
  alone. `next.risk` — set **before** acting.

A rejected patch never modifies Σ. Read the category (`guard`, `path`, `unknown-key`,
`type-coercion`, `schema`, `skill`), fix the patch, retry. Do not reword your intent to slip
past a guard: the guard is the domain rule, and `task_history` keeps every rejection.

**Σ is re-injected on every turn, so its size is a recurring cost.** Store what future steps
need and compress finished work into its outcome — one line in `decisions`, not a narrative of
how you got there. When the runtime tells you Σ is too long, believe it and cut.

## Delegating to subagents

A subagent is a separate context that is thrown away when it finishes: whatever it learned dies
with it unless it lands in Σ or on a page. That is what makes the pair work — and what makes an
undocumented delegation a pure loss.

**One owner of Σ.** The session that delegates owns the state: the subagent reports, the
orchestrator patches. Two agents patching one Σ is how a plan item gets marked `done` twice, and
a `guard` rejection is the state telling you it happened. Give a subagent the skillstate tools
only when it _is_ the worker for a step and nothing else patches while it runs — and then give
it its own root (the `project` argument, `SKILLSTATE_PROJECTS`), not yours.

**Brief it; do not hand it the transcript.** A subagent starts with no history. Say what the job
is, what done looks like, which files are in scope and which are not, and which checks must
pass. Where the host injects state into subagents, yours will also see the goal, the step in
flight and the next action with its risk — enough to avoid opening a second task or redoing
finished work, and deliberately not the whole of Σ, which it would pay for on every one of its
own turns. Everything specific is still yours to give.

**Take the cheapest agent that can do the job, and the narrowest toolset.** A lookup does not
need the model you think with. An explicit `tools` allowlist also keeps every declaration the
agent does not need — these nine included — out of its prompt on every turn, and a turn cap
bounds the cost when it wanders.

**Pay for the answer, not the journey.** A subagent's output lands in _your_ context. Ask for
the shape you need — findings with `file:line`, a list of paths, a verdict — and a bound on its
length. Ten thousand tokens of narrated exploration is a delegation that cost more than doing
the work yourself.

**Verify, then record.** Its report is a claim, not evidence: check it against `git diff`, the
file on disk, or the real output of the command before any of it goes into Σ. Then write down
what outlives the task — the check in `verifications`, the surprising part on a page. The
subagent will not be around to ask.

**Fork when the job needs this conversation.** A fork inherits your context and shares your
prompt cache; a named subagent starts empty and pays to be briefed. Fork when the work depends
on what has already been said here, delegate when a clean narrow brief is cheaper than the
history.

## Writing the project's memory

Pages are the half that lets a stranger — or you next week, with no transcript — start work
here. Six kinds: the singletons `project` (what this is, stack, layout, commands),
`user-intent` (what the user wants, what is out of scope) and `onboarding` (how to start
here), whose id equals the kind; plus the repeatable `feature`, `decision` and `note`. A page
carries `status` (`current` by default, `stale`, `archived` — archived stays out of the
brief), `pin` (keep it in the cold-start brief), and nesting through `parent`.

Write it down as you learn it, not at the end:

- chose one approach over another and the reason is not obvious from the code → `decision`
- built something a newcomer must know exists → `feature`
- hit a gotcha that will bite again (a format the parser rejects, a command that lies about
  its exit code, an API unlike its docs) → `note`, or the sharp-edges part of `project`
- the layout or the build/test commands changed → update `project` in the same session
- learned something new about what the user actually wants → `user-intent`

Link pages to the tasks that produced them — `page {"op":"link","from":"page:<id>","rel":
"implements","to":"task:<id>"}`, with `rel` from `documents`, `implements`, `decides`,
`supersedes`, `see-also`. From a feature page you then see the task that built it, and from a
task what is written about it (`op:"links"` with `ref`, optionally `direction`).

Two habits decide whether pages are worth anything:

- **One informative line in `summary`** (≤200 chars). A cold session sees the brief — id,
  title, summary — and decides from that alone whether to open the page. A summary reading
  "notes" costs a `page get` and teaches nothing.
- **Point at code, do not copy it.** The repository stays current; a pasted copy in a body
  does not. Write `src/kb/brief.ts trims by whole lines, never mid-line` instead of pasting
  the function.

Keep out of pages what is already authoritative elsewhere: git history and blame, the code
itself, dependency manifests, and the ephemeral state of the task in flight — that last one is
Σ's job.

## Fixing a bug with no context

The case this whole setup exists for. You have no transcript, only the database:

1. `project_brief`, then `task_show` if a task is open — Σ may already name the bug, its root
   cause, or the last thing that was verified.
2. `search {"query":"<the exact error text>"}` and `search {"query":"<the file or feature>"}`,
   narrowed with `kind:"task"` or `kind:"page"` (default both, `limit` ≤ 50, default 10).
   Every word must appear in the same hit, and a substring of an identifier works. An empty
   result means "not written down", not "searched wrong" — a typo or a partial word still
   answers, because a failed match falls back to a substring scan.
3. `task_history` on a related task: rejected patches record what was tried and refused.
4. `git log` / `git blame` for what actually changed. Σ says what was intended and verified;
   git is authoritative for the diff.
5. Only then read code — the parts those steps pointed at.
6. `task_start` with a plan of reproduce → fix → verify. When you find the root cause, record
   it as a `note` or `decision` page: the fix belongs in the code, the reason it was needed
   belongs in the knowledge base.

## Risk and confirmation

`next.risk` describes the action you are about to take. Set it **before** acting:

- `safe` — reading files, local edits, running tests.
- `destructive` — deleting files or branches, dropping tables, `force-push`, overwriting
  somebody else's changes.
- `external` — anything reaching beyond this project's working tree: `git push`, PR/issue
  comments, sending messages, deploying, calling external services, changing user-level
  config (global agent settings, linking extensions, installing global packages).

For `destructive` or `external`: say what will happen and ask the user first. Never silently,
and never by routing around a denial — no shell indirection, generated script, alias, or
config change to achieve what was refused. The host's own approval prompts are a second layer,
not a substitute for asking.

## Before you stop

- The real checks are in `verifications` with their actual results, and your answer to the
  user reports them faithfully: a failure as a failure, an unrun check as unrun.
- Σ is compressed — finished work reduced to its outcome, dead keys removed with `null`.
- What you learned is a page, and `project` / `user-intent` are `current` if they changed.
- Either `task_finish` with the outcome, or `next.action` and `next.risk` saying exactly where
  the next session picks up. "Continue the work" is not a next action;
  `run npm test, expect 0 failures, then patch plan[2] to done` is.

`.skillstate/` is not versioned (it belongs in `.gitignore`): the database is the agent's
working memory, the repository is the product.

## This project

<Keep this section under ten lines — it is loaded into every session, and everything longer
belongs on the `project` page. Replace the placeholders and delete this note.>

- Verify with: <the one command that proves this project is healthy>
- Do not touch: <files or directories that are not yours to edit, and why>
- Must not be guessed: <indentation, naming, where tests live, how files are written>
- Answer the user in: <language>
