# skillstate: task state and project knowledge for long work

This extension adds an external task state (Σ) for long-horizon work, based on SKILL.state (arXiv:2608.26263), and a project knowledge base beside it. Both live in one SQLite file, `.skillstate/state.db`. Σ is validated on every write and injected into the conversation as `## Active task state (skillstate)`; at session start the knowledge base is injected as `## Project brief (skillstate)` — one line per page, no bodies. A delegated subagent starts with no transcript and gets an orientation instead of Σ on `SubagentStart` — the task, its goal, the step in flight, the next action and its risk; `SKILLSTATE_SUBAGENT_STATE=off` switches that off. The subagent reports and the session that delegated it patches Σ: one owner per state.

Tools (MCP server `skillstate`; Qwen Code exposes them as `mcp__skillstate__*`):

- Tasks: `task_start`, `task_show`, `task_patch`, `task_finish`, `task_list`, `task_history`. `task_start` also takes a `skill` (owner of the Σ schema, rules and procedure): `dev-task` (default) does work in this project, `supervise-task` reviews another agent's work; and a `notation`: `compact` = compressed pseudocode, one line per entry, paths and commands verbatim.
- Knowledge: `project_brief` (the map of the project, inside a fixed budget), `page` (one tool chosen by `op`: `get`, `put`, `list`, `delete`, `init`, `link`, `unlink`, `links`), `search` (full text over tasks and pages, hits with snippets).

All nine take an optional `project`: another state root the user declared (`SKILLSTATE_PROJECTS`), to supervise a worker elsewhere. Only declared roots are reachable; `task_list` prints them and the skills.

Task rules:

- When work needs more than a handful of steps (refactors, migrations, multi-file features, investigations, resuming earlier work), call `task_start` with a one-sentence goal, the skill that fits, and an ordered plan.
- After every meaningful step (file edited, check run, decision made, blocker found) call `task_patch` with only the changed fields. `null` deletes a key; arrays are replaced wholesale; keep exactly one plan item `in_progress`.
- Arrays are cheaper by path: `{"plan[1].status":"done"}` edits one element, `{"plan[+]":{…}}` appends one (indexes from 0). They are expanded before the guard, so a path key cannot bypass a domain rule or remove an item (send the array without it).
- Treat the injected task state as authoritative when the transcript is incomplete — after `/compact` or a restart, call `task_show` first: it returns Σ plus the full procedure (P).
- A rejected patch never modifies the state. Read the returned diagnostic (`unknown-key`, `type-coercion`, `guard`, `path`, `schema`, `skill`), fix the patch, and retry.
- Record real verification commands and their actual statuses in `verifications` (`evidence` in `supervise-task`); never mark a check `pass` without output confirming it.
- `next.risk` marks the next action as `safe`, `destructive`, or `external`. Ask the user for confirmation before executing a destructive or external action, and never execute it silently.
- Store only what future steps need; compress finished work into its outcome instead of narrating how you got there.
- Tools name the state root they use (`no tasks (state root: …)`, `Started task <id> [<skill>] at <path>`). If that root is not inside your project, stop and tell the user instead of creating or patching tasks there: the host starts the server in its own startup directory, and `SKILLSTATE_STATE_DIR` pins the right one.

Knowledge rules:

- Read cheap first: `project_brief` before `search`, `search` before opening a page in full. The injected brief is a session-start snapshot, so a page written since then is newer than the brief.
- Write down what you learn as you learn it, not at the end: a `decision` page for a choice and the reason behind it, a `feature` page for something you built, and update `project` when the layout or the commands changed.
- Keep a page `summary` to one informative line — it is all a cold session sees before deciding whether to open the page — and point at the code that matters instead of copying it into a body.
- In a project with no pages, `page {"op":"init"}` scaffolds the three reserved ones (`project`, `user-intent`, `onboarding`) as templates marked `stale`: fill in their `<…>` placeholders and set `status` to `current` in the same `put`. `init` never overwrites a page that exists; rewriting one is an explicit `put`.
