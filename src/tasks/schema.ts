import { z } from 'zod';
import type { Skill } from '../core/skill.js';
import { isPlainObject } from '../core/state.js';
import type { StateDict } from '../core/types.js';
import { composeProcedure, PATCH_SEMANTICS, RISK_RULES, STATE_HYGIENE } from './procedure.js';

export const TASK_STATUSES = ['active', 'blocked', 'done'] as const;
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
}

export interface Verification {
  check: string;
  status: VerificationStatus;
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
});

const verificationSchema = z.strictObject({
  check: z.string().min(1),
  status: z.enum(VERIFICATION_STATUSES),
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
- status: "active" | "blocked" | "done".
- plan: array of { id, task, status, notes }. ids are sequential strings "1", "2", … Exactly one item may be "in_progress" at a time.
- artifacts: map from file path (or resource key) to a one-line description of what it is / what changed.
- verifications: array of { check, status } where check is the literal command ("npm test", "npm run lint", …) and status is "pass" | "fail" | "pending". Never mark "pass" without real output confirming it.
- decisions: append-only log of significant choices, one line each.
- blockers: list of things preventing progress (empty when not blocked).
- next: { action, risk } — the very next concrete step and its risk level.`;

const DEV_TASK_RULES: string = `Task rules:
- Move the finished plan item to "done" and exactly one other item to "in_progress" in the same patch.
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
