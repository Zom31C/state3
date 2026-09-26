/**
 * Procedure blocks shared by every skill. A skill composes its P from these plus
 * the description of its own Σ, so the merge semantics, the risk taxonomy and the
 * state hygiene rules have exactly one source of truth.
 */

import { patchCategoryList } from '../core/rejections.js';

export const RISK_RULES: string = `Risk levels for next.risk:
- "safe": reading files, local edits, running tests.
- "destructive": deleting files/branches, dropping tables, force-push, overwriting others' changes.
- "external": anything that reaches beyond this project's working tree — push, PR/issue comments, sending messages, deploy, calling external services, changing user-level config (global agent settings, linking extensions, installing global packages).
Before executing an action whose risk is "destructive" or "external", you MUST ask the user for confirmation. Never execute such actions silently.`;

export const PATCH_SEMANTICS: string = `Patch semantics (ΔΣ merged into Σ with ⊕):
- A null value deletes the key. Example: {"artifacts": {"src/old.ts": null}} removes that artifact. Keys of an object are addressed nested like this, never by a dotted top-level key: {"artifacts.src/old.ts": null} names no field and is rejected as unknown-key.
- Arrays are replaced wholesale. To change one item you may send the entire array with the updated element.
- Nested plain objects merge recursively; scalars replace.
- Cheaper for arrays — a path key touches one element: {"plan[1].status": "done"}, {"rounds[0].verdict": "accepted"}, and {"plan[+]": {…}} appends an item. Indexes count from 0.
- An element may also be named by its own id: {"plan[id=5].notes": "…"}, {"plan[id=5]": null}. Safer than an index, because a step's id and its position differ as soon as a step is added or removed.
- A path key with null and no keys below it removes that element: {"verifications[2]": null}. Removal shifts the indexes below it, so a patch removing two elements is applied in the order its keys were written.
- Prefer a path key over resending the array. One field cannot be sent both wholesale and by path in the same patch.
- One key addresses the tree instead of Σ: {"parent": "<task id>"} re-files this task under another one, taking its own subtasks with it, and {"parent": null} makes it a root task. Its status does not change. Refused when the new parent does not exist, is done, or already sits under this task — that move would close a loop no reader could walk.
- A rejected patch never modifies the state. Read the diagnostic category (${patchCategoryList()}), fix the patch, and retry.`;

export const STATE_HYGIENE: string = `State hygiene:
- Store only what future steps need. Compress finished work to its outcome: one entry in decisions, not a narrative of how you got there.
- Send a patch after every meaningful step (work done, check run, decision made, blocker found).
- Keep next.action specific and actionable so the next session can resume without re-reading the transcript.
- Report verifications faithfully: never claim a check passed without output confirming it.
- If a tool reports a state root outside your project, stop and tell the user — do not create or patch tasks in a directory you did not expect.`;

/** Joins non-empty blocks into the procedure P. */
export function composeProcedure(...blocks: readonly string[]): string {
  return blocks
    .map((block) => block.trim())
    .filter((block) => block !== '')
    .join('\n\n');
}
