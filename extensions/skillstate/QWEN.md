# skillstate: task state for long work

This extension adds an external task state (Σ) for long-horizon work, based on SKILL.state (arXiv:2608.26263). Σ lives in `.skillstate/<id>.json` in the project, is validated on every write, and is injected into the conversation as `## Active task state (skillstate)`.

Tools (MCP server `skillstate`; Qwen Code exposes them as `mcp__skillstate__task_*`): `task_start`, `task_show`, `task_patch`, `task_finish`, `task_list`, `task_history`. `task_start` also takes a `skill` (owner of the Σ schema, rules and procedure): `dev-task` (default) does work in this project, `supervise-task` reviews another agent's work; and a `notation`: `compact` = compressed pseudocode, one line per entry, paths and commands verbatim. All tools take an optional `project`: another state root the user declared (`SKILLSTATE_PROJECTS`), to supervise a worker elsewhere. Only declared roots are reachable; `task_list` prints them and the skills.

Rules:

- When work needs more than a handful of steps (refactors, migrations, multi-file features, investigations, resuming earlier work), call `task_start` with a one-sentence goal, the skill that fits, and an ordered plan.
- After every meaningful step (file edited, check run, decision made, blocker found) call `task_patch` with only the changed fields. `null` deletes a key; arrays are replaced wholesale; keep exactly one plan item `in_progress`.
- Arrays are cheaper by path: `{"plan[1].status":"done"}` edits one element, `{"plan[+]":{…}}` appends one (indexes from 0). They are expanded before the guard, so a path key cannot bypass a domain rule or remove an item (send the array without it).
- Treat the injected task state as authoritative when the transcript is incomplete — after `/compact` or a restart, call `task_show` first: it returns Σ plus the full procedure (P).
- A rejected patch never modifies the state. Read the returned diagnostic (`unknown-key`, `type-coercion`, `guard`, `path`, `schema`, `skill`), fix the patch, and retry.
- Record real verification commands and their actual statuses in `verifications` (`evidence` in `supervise-task`); never mark a check `pass` without output confirming it.
- `next.risk` marks the next action as `safe`, `destructive`, or `external`. Ask the user for confirmation before executing a destructive or external action, and never execute it silently.
- Store only what future steps need; compress finished work into its outcome instead of narrating how you got there.
- Tools name the state root they use (`no tasks (state root: …)`, `Started task <id> [<skill>] at <path>`). If that root is not inside your project, stop and tell the user instead of creating or patching tasks there: the host starts the server in its own startup directory, and `SKILLSTATE_STATE_DIR` pins the right one.
