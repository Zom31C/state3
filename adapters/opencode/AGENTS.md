# skillstate in opencode: supplement to the project's AGENTS.md

The rules for working with skillstate are host-independent and live in one place:
[`templates/AGENTS.md`](../../templates/AGENTS.md) in the skillstate repository. Copy that
file to the root of your project as `AGENTS.md` first (step 4 of the installation below),
then append the "opencode specifics" section of this file to it.

This file kept only what opencode does differently, so that the rules do not drift between
two copies. Russian prose stays in [README.md](./README.md) — the adapter's own
documentation; the block below is in English because it ends up inside a project `AGENTS.md`
next to the English template.

## opencode specifics (append to the project's AGENTS.md)

### How Σ reaches you here

- Tools carry the server-name prefix: `skillstate_task_show`, `skillstate_page`,
  `skillstate_search`. They are switched off in the config with the mask
  `"skillstate_*": false`.
- The `skillstate` plugin pushes compact Σ into the system prompt of every request and into
  the compaction context, and the knowledge-base brief on the first request of a session and
  on compaction — not on every request. opencode has no per-prompt injection event, so the
  brief is what the session sees once, and `project_brief` is how you refresh it.
- If Σ is missing from the context although a task is open, the plugin did not find the
  skillstate build: read the state with `task_show` and tell the user (the plugin logs a
  `warn` mentioning `state.db`). A root with `state.db` is read through the build
  (`dist/tasks/inject.js`, found via `SKILLSTATE_HOME` or by walking up from the plugin
  file); a legacy JSON root is read without it. A root with `state.db` is authoritative — the
  JSON files beside it are the archive the migration left, and they are not injected.
- The injected block from a legacy root carries no skill name and no compact-notation
  reminder; `task_show` returns both, together with the procedure P.
- The plugin injects **one** root and does not read `SKILLSTATE_PROJECTS`: for another
  declared project use `task_show {"project":"<name>"}`. The MCP server does read
  `SKILLSTATE_PROJECTS` — from the environment of the opencode process or from the
  `environment` block of its mcp config — so the `project` argument works even though the
  injection covers one root.
- When opencode is launched outside the project directory, `SKILLSTATE_STATE_DIR` pins the
  state directory; `SKILLSTATE_ROOT` sets the project directory the plugin looks in.

### The optional guard

`SKILLSTATE_GUARD=1` makes the plugin throw on `bash`, `write`, `edit` and `patch` calls
while the active task's `next.risk` is `destructive` or `external`. It is enforcement on top
of the rule "ask the user before a destructive or external action", and it is off by default
because it deliberately interrupts tool calls; opencode's own permission system
(`permission.ask`) is the second layer, not a replacement for asking. Setting `next.risk`
before acting is still your job — the guard can only block what Σ already describes.

## Installation and the rest

Installation (plugin, mcp config, `AGENTS.md`, self-test), what each plugin hook does, the
environment variables, debugging, the end-to-end run against a local model and the known
limitations are in [README.md](./README.md) — step 4 there is the one that puts the shared
template and the block above into the project's `AGENTS.md`.
