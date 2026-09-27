import { z } from 'zod';
import type { Skill } from '../core/skill.js';
import { isPlainObject } from '../core/state.js';
import type { StateDict } from '../core/types.js';
import { composeProcedure, PATCH_SEMANTICS, RISK_RULES, STATE_HYGIENE } from './procedure.js';

export const TASK_STATUSES = ['pending', 'active', 'blocked', 'done'] as const;
export const PLAN_ITEM_STATUSES = ['pending', 'in_progress', 'done', 'skipped'] as const;
export const VERIFICATION_STATUSES = ['pass', 'fail', 'pending'] as const;
export const RISK_LEVELS = ['safe', 'destructive', 'external'] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type PlanItemStatus = (typeof PLAN_ITEM_STATUSES)[number];
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];
export type RiskLevel = (typeof RISK_LEVELS)[number];

export interface PlanItem {
  id: string;
  task: string;
  status: PlanItemStatus;
  notes: string;
  /**
   * Set once this step's outcome is folded into `decisions` and its own text no longer
   * earns a place in the prompt. An archived step stays in Σ — indexes do not move, and
   * `task_show` lists every one — but the injected view leaves it out and reports how
   * many it left out. This is the only field whose purpose is to make Σ cheaper.
   */
  archived?: boolean | undefined;
}

export interface Verification {
  check: string;
  status: VerificationStatus;
  /**
   * When this result was recorded, and the commit it was recorded against. Both are
   * written by the runtime, not sent by the agent: the agent does not know the commit, and
   * a check reported without them cannot be told apart from one reported before the fix.
   * `commit` is null outside a git repository.
   */
  at?: string | undefined;
  commit?: string | null | undefined;
}

export interface NextStep {
  action: string;
  risk: RiskLevel;
}

export interface DevTaskState {
  goal: string;
  status: TaskStatus;
  plan: PlanItem[];
  artifacts: Record<string, string>;
  verifications: Verification[];
  decisions: string[];
  blockers: string[];
  next: NextStep;
}

const planItemSchema = z.strictObject({
  id: z.string(),
  task: z.string().min(1),
  status: z.enum(PLAN_ITEM_STATUSES),
  notes: z.string(),
  archived: z.boolean().optional(),
});

const verificationSchema = z.strictObject({
  check: z.string().min(1),
  status: z.enum(VERIFICATION_STATUSES),
  at: z.string().optional(),
  commit: z.string().nullish(),
});

export const nextStepSchema = z.strictObject({
  action: z.string().min(1),
  risk: z.enum(RISK_LEVELS),
});

export const devTaskSchema: z.ZodType<DevTaskState> = z.strictObject({
  goal: z.string().min(1),
  status: z.enum(TASK_STATUSES),
  plan: z.array(planItemSchema),
  artifacts: z.record(z.string(), z.string()),
  verifications: z.array(verificationSchema),
  decisions: z.array(z.string()),
  blockers: z.array(z.string()),
  next: nextStepSchema,
});

/**
 * Domain guard for the dev-task skill. Deterministic; never throws.
 * Returns null when the patch is acceptable, or an English error message.
 */
export function devTaskGuard(state: StateDict, patch: StateDict): string | null {
  // Rule 1: a finished task cannot be reopened.
  const patchStatus = patch.status;
  const currentStatus = state.status;
  if (patchStatus !== undefined && currentStatus === 'done' && patchStatus !== currentStatus) {
    return 'task is done; start a new task instead of reopening this one';
  }

  // Rule 2: a done plan item may only be reopened with an explanation in notes.
  const patchPlan = patch.plan;
  if (Array.isArray(patchPlan)) {
    const currentPlan = state.plan;
    if (Array.isArray(currentPlan)) {
      for (const patchItem of patchPlan) {
        if (!isPlainObject(patchItem)) continue;
        const id = patchItem.id;
        if (typeof id !== 'string') continue;

        for (const currentItem of currentPlan) {
          if (!isPlainObject(currentItem)) continue;
          if (currentItem.id !== id) continue;
          if (currentItem.status !== 'done') continue;

          const newStatus = patchItem.status;
          if (newStatus === 'done') continue;

          const newNotes = patchItem.notes;
          if (typeof newNotes === 'string' && newNotes.trim() !== '') continue;

          return `plan item ${id} is done; add an explanation in notes to reopen it`;
        }
      }
    }
  }

  // Rule 3: blocked status requires at least one blocker entry.
  if (patchStatus === 'blocked' && Array.isArray(patch.blockers) && patch.blockers.length === 0) {
    return 'status blocked requires at least one entry in blockers';
  }

  return null;
}

const DEV_TASK_INTRO: string = `You are a software engineering agent working on a long task. Your progress lives in an external task state, not in the conversation transcript. The state survives session compaction, so future steps read it to understand what has been done and what comes next.`;

const DEV_TASK_STATE_DICT: string = `State dictionary (all keys required, strict schema — unknown keys are rejected):
- goal: one-sentence description of the objective.
- status: "pending" | "active" | "blocked" | "done". A subtask starts "pending" — queued behind the work in flight, and handed over when its turn comes; "active" is the task being worked now. "pending" means a place in a queue, so a root task cannot have it: nothing would ever hand it over.
- plan: array of { id, task, status, notes } plus an optional "archived": true. ids are sequential strings "1", "2", … Exactly one item may be "in_progress" at a time. An archived item stays in the array — its index and its id do not move — but the state injected into the prompt leaves it out and says how many it left out.
- artifacts: map from file path (or resource key) to a one-line description of what it is / what changed.
- verifications: array of { check, status } where check is the literal command ("npm test", "npm run lint", …) and status is "pass" | "fail" | "pending". Never mark "pass" without real output confirming it. The runtime stamps every entry you add or change with "at" (when) and "commit" (the project's git HEAD, null outside a repository) — send neither yourself. An entry you resend with the same field values keeps the stamp it had, whatever order you write them in; rewording one makes it a new claim, re-stamps it, and the answer names the stamp that was replaced.
- decisions: append-only log of significant choices, one line each. A patch replaces the whole array, so an entry you leave out leaves Σ: the answer names the entries that were dropped and task_history keeps their text. Append; do not rewrite what is already recorded.
- blockers: list of things preventing progress (empty when not blocked).
- next: { action, risk } — the very next concrete step and its risk level.`;

const DEV_TASK_RULES: string = `Task rules:
- Move the finished plan item to "done" and exactly one other item to "in_progress" in the same patch.
- Once a finished step's outcome is recorded in decisions, archive it in the same patch: {"plan[3].status":"done","plan[3].archived":true}. Archiving is what stops Σ from growing with every step you complete — the injected state drops archived steps and says how many, while task_show still lists all of them.
- Split rather than queue: a step that will take more than a handful of actions, or that you will delegate to another agent, becomes a subtask — task_start {"goal":…,"parent":"<this task id>"} — and not another plan item. Σ is carried on every prompt of the task, so ten pending plan items are ten lines you pay for on every turn of the first one, while a subtask costs its parent one line of queue and carries its own state only while it is in flight.
- A subtask starts "pending" and the runtime hands it over when its turn comes: closing a piece promotes the next queued one to "active" and the answer names it, and the injection names the queue under "Queued after this". Set "active" yourself when the injection reports the piece at the frontier as not yet taken — the first piece of a split has no predecessor to close, so nothing promotes it — or when you take a piece out of order.
- Close a decomposition last. A task with open subtasks cannot go to "done" — finish or skip them, then close the parent with the outcome of the whole recorded in decisions.
- When blocked: set status "blocked" and add at least one entry to blockers; clear them when work resumes.
- Set status "done" only after every plan item is "done" or "skipped" and the key verifications are "pass".`;

export const DEV_TASK_INSTRUCTIONS: string = composeProcedure(
  DEV_TASK_INTRO,
  DEV_TASK_STATE_DICT,
  RISK_RULES,
  PATCH_SEMANTICS,
  DEV_TASK_RULES,
  STATE_HYGIENE,
);

export function devTaskInitialState(goal: string): DevTaskState {
  return {
    goal,
    status: 'active',
    plan: [],
    artifacts: {},
    verifications: [],
    decisions: [],
    blockers: [],
    next: { action: 'Break the goal into plan items and pick the first one', risk: 'safe' },
  };
}

/** Progress for list views: finished plan items over all of them. */
export function devTaskProgress(state: StateDict): { done: number; total: number } {
  const plan = state.plan;
  if (!Array.isArray(plan)) return { done: 0, total: 0 };
  let done = 0;
  for (const item of plan) {
    if (isPlainObject(item) && item.status === 'done') done += 1;
  }
  return { done, total: plan.length };
}

export function devTaskSkill(): Skill {
  // Object literal (not the interface-typed return of devTaskInitialState) so
  // TypeScript sees a fresh type assignable to the StateDict index signature.
  return {
    name: 'dev-task',
    instructions: DEV_TASK_INSTRUCTIONS,
    schema: devTaskSchema,
    initialState: {
      goal: 'placeholder',
      status: 'active',
      plan: [],
      artifacts: {},
      verifications: [],
      decisions: [],
      blockers: [],
      next: { action: 'Break the goal into plan items and pick the first one', risk: 'safe' },
    },
    guard: devTaskGuard,
    newPlanItem: (task, index) => ({
      id: String(index + 1),
      task,
      status: 'pending',
      notes: '',
    }),
    progress: devTaskProgress,
  };
}
