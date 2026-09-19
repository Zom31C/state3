---
name: long-task
description: Run a long, multi-step development task on an external validated state instead of the conversation transcript. Use when work spans many steps or files (refactors, migrations, multi-file features, investigations), when the session may be compacted or restarted, or when the user asks to resume earlier work. Invoke with /long-task followed by the goal.
argument-hint: '<goal of the long task>'
---

# Long task on external state (SKILL.state)

Keep the progress of a long job in the skillstate task state Σ, not in the
transcript. Σ is compact, validated on every write, and survives `/compact` and
restarts. The tools come from the MCP server `skillstate`: `task_start`,
`task_show`, `task_patch`, `task_finish`, `task_list`, `task_history` — in Qwen
Code they are exposed as `mcp__skillstate__task_start` and so on.

## 1. Start

Call `task_start` with a one-sentence goal and an ordered plan (one string per
step). Do this before the first edit when the job needs more than a handful of
steps, and when the user asks to resume work that already has a task.

Choose the skill with the `skill` argument: `dev-task` (the default) is for work
you do in this project, `supervise-task` is for reviewing work another agent
does — it has no plan array, so start it with just a goal and fill `spec`,
`worker` and `rounds` by patching. Choose how Σ is written with the `notation`
argument: `plain` prose by default, `compact` pseudocode when every injected
character counts (a small-context local model, a very long task). `task_list`
prints the skills and the projects this runtime has.

If a task already exists, call `task_list` and then `task_show` instead of
starting a second one — one active task per project.

## 2. Work and patch

After every meaningful step — a file edited, a check run, a decision made, a
blocker found — call `task_patch` with only the fields that changed:

- `plan`: mark the finished item `done`, move exactly one item to `in_progress`,
  and put the concrete next step into `next.action`.
- `artifacts`: one line per touched file or resource — what it is now. Remove
  stale entries with `null` (for example `{"artifacts": {"src/old.ts": null}}`).
- `verifications`: the literal command (`npm test`, `npm run lint`, …) and its
  real status. Never mark `pass` without output confirming it. The runtime stamps
  every entry with `at` and `commit` (the project's git HEAD, `null` outside a
  repository) — send neither yourself, so a `pass` stays tied to the tree it
  passed on.
- `decisions`: append the choices future steps must respect, one line each, with
  the reason. Do not narrate the work.
- `blockers` + `status: "blocked"` when progress stops; clear them when it
  resumes.

Arrays are replaced wholesale, so changing one `plan` item means resending the
whole array — unless you address that item with a **path key**:
`{"plan[1].status": "done"}` sets one field of one element,
`{"plan[0].notes": "reopened: the fix regressed"}` another, and
`{"plan[+]": {…}}` appends an element. `{"verifications[2]": null}` removes one
— a removal shifts the indexes below it, so a patch removing two applies in the
order its keys were written. An element may be named by its own id instead of
its position: `{"plan[id=5].notes": "…"}`, `{"plan[id=5]": null}`. Prefer it — a
step's id and its index differ as soon as a step is added or removed, and a
refusal prints the pairing. Indexes count from 0, and the same form works for any
array field of your skill's Σ — `{"decisions[+]": "…"}`,
`{"rounds[0].verdict": "accepted"}`. Path keys are expanded before the guard and
the schema run, so they cannot bypass a domain rule; they do not address plain
objects (those already merge recursively), and one field cannot be sent both
wholesale and by path in the same patch.

Store only what future steps need. Compress finished work into its outcome. If
the task uses compact notation, write Σ values as compressed pseudocode: one
line per entry, symbols instead of prose, paths and commands verbatim, and never
a compressed-away constraint or failing command. When Σ grows,
`task_show {"view":"size"}` says which field to shorten first, and
`{"plan[0].archived": true}` keeps a finished step in Σ but drops it from the
injection on every prompt.

A rejected patch never modifies the state. Read the diagnostic category
(`unknown-key`, `type-coercion`, `guard`, `path`, `schema`, `skill`), fix the
patch, and retry. Domain rules enforced by the guard: a finished task cannot be
reopened (start a new one), a `done` plan item can only be reopened with an
explanation in its `notes`, and `status: "blocked"` requires at least one
blocker.

## 3. Confirm risky actions

`next.risk` describes the action you are about to take:

- `safe` — reading files, local edits, running tests.
- `destructive` — deleting files or branches, dropping tables, `force-push`,
  overwriting someone else's changes.
- `external` — anything that reaches beyond this project's working tree:
  `git push`, PR/issue comments, sending messages, deploying, calling external
  services, changing user-level config (global agent settings, linking
  extensions, installing global packages).

Set the risk **before** acting. For `destructive` or `external`, state what will
happen and ask the user for confirmation; do not execute it silently, and do not
look for a way around a denial. The host approval system is a second layer, not a
replacement for asking.

Tools also name the state root they use (`no tasks (state root: …)`,
`Started task <id> [<skill>] at <path>`). If that root is not inside your
project, stop and tell the user: the host starts the MCP server in its own
startup directory, which is not necessarily the project, and
`SKILLSTATE_STATE_DIR` pins the right one.

## 4. Resume after compaction or restart

When the transcript is short, ambiguous, or missing, call `task_show` first: it
returns Σ plus the full procedure P. Then continue from `next.action` without
re-deriving what has already been done. Use `task_history` to audit what changed
and why a patch was rejected.

## 5. Finish

When the goal is reached — all plan items `done` or `skipped` and the key
verifications `pass` — call `task_finish` with a short summary of the outcome.
Report verification results faithfully: if a check failed or was not run, say so
in the state and in your answer.

## 6. A task in another project

Every tool takes an optional `project` argument: the name of a state root the
user declared, either in `SKILLSTATE_PROJECTS` (`name=dir;name2=dir2`, or a JSON
object of the same) or with `--project name=dir` on the server. This is how one
supervising session reads and patches the Σ of a worker agent running in a
different project directory: `task_show` with `{"project": "worker"}`, review the
artifacts yourself, then `task_patch` with the same argument.

Only declared roots are reachable, and an unknown name is an error that lists
them — never try to reach a directory that was not declared, ask the user to
declare it. When roots are declared, the Qwen Code hook also injects the active
task of each of them under `## Supervised projects (skillstate)`, so their Σ is
in context before you spend a tool call on it.
