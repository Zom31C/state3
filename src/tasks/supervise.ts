import { z } from 'zod';
import type { Skill } from '../core/skill.js';
import { isPlainObject } from '../core/state.js';
import type { StateDict, StateValue } from '../core/types.js';
import { composeProcedure, PATCH_SEMANTICS, RISK_RULES, STATE_HYGIENE } from './procedure.js';
import { nextStepSchema, TASK_STATUSES } from './schema.js';
import type { NextStep, TaskStatus } from './schema.js';

export const ROUND_VERDICTS = ['pending', 'accepted', 'rejected'] as const;

export type RoundVerdict = (typeof ROUND_VERDICTS)[number];

export interface Round {
  id: string;
  /** What the worker was told to produce in this cycle. */
  assignment: string;
  verdict: RoundVerdict;
  /** What the supervisor checked itself: files read, commands run, output seen. */
  evidence: string;
  /** What the worker must change; empty once the round is accepted. */
  feedback: string;
}

/**
 * Σ of a supervising agent: it owns the specification and the review, while a
 * worker agent owns the artifacts. Different shape and different guard from
 * dev-task, which is the point — the runtime is not tied to one domain.
 */
export interface SuperviseTaskState {
  goal: string;
  status: TaskStatus;
  /** Where the authoritative specification lives, and which revision the worker follows. */
  spec: string;
  /** Who implements it: model, runtime, and the root of the worker's own task state. */
  worker: string;
  rounds: Round[];
  decisions: string[];
  blockers: string[];
  next: NextStep;
}

const roundSchema = z.strictObject({
  id: z.string(),
  assignment: z.string().min(1),
  verdict: z.enum(ROUND_VERDICTS),
  evidence: z.string(),
  feedback: z.string(),
});

export const superviseTaskSchema: z.ZodType<SuperviseTaskState> = z.strictObject({
  goal: z.string().min(1),
  status: z.enum(TASK_STATUSES),
  spec: z.string(),
  worker: z.string(),
  rounds: z.array(roundSchema),
  decisions: z.array(z.string()),
  blockers: z.array(z.string()),
  next: nextStepSchema,
});

function hasText(value: StateValue | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Domain guard for supervision. Deterministic; never throws. The failure modes it
 * blocks are the ones that make delegation useless: accepting on the worker's
 * word, rejecting without saying what to change, and piling up unreviewed runs.
 */
export function superviseTaskGuard(state: StateDict, patch: StateDict): string | null {
  const patchStatus = patch.status;
  if (patchStatus !== undefined && state.status === 'done' && patchStatus !== state.status) {
    return 'task is done; start a new task instead of reopening this one';
  }
  if (patchStatus === 'blocked' && Array.isArray(patch.blockers) && patch.blockers.length === 0) {
    return 'status blocked requires at least one entry in blockers';
  }

  const rounds = patch.rounds;
  if (!Array.isArray(rounds)) return null;

  let pending = 0;
  for (const round of rounds) {
    if (!isPlainObject(round)) continue;
    const id = typeof round.id === 'string' && round.id !== '' ? round.id : '?';
    if (round.verdict === 'pending') {
      pending += 1;
      continue;
    }
    if (round.verdict === 'accepted' && !hasText(round.evidence)) {
      return `round ${id} cannot be accepted without evidence: record what you checked yourself (files read, commands run, output seen)`;
    }
    if (round.verdict === 'rejected' && !hasText(round.feedback)) {
      return `round ${id} cannot be rejected without feedback: say what the worker must change`;
    }
  }
  if (pending > 1) {
    return 'one round at a time: review the pending round before assigning the next one';
  }
  return null;
}

const SUPERVISE_INTRO: string = `You are supervising a long task that another agent (the worker) implements. You own the specification and the review; the worker owns the artifacts. Your progress lives in an external task state, not in the conversation transcript, so it survives compaction and restarts.`;

const SUPERVISE_STATE_DICT: string = `State dictionary (all keys required, strict schema — unknown keys are rejected):
- goal: what the supervised work must deliver, one sentence.
- status: "active" | "blocked" | "done".
- spec: where the authoritative specification lives (path or URL) and which revision the worker follows.
- worker: who implements it — model, runtime, and the root of the worker's own task state, so its progress can be read.
- rounds: array of { id, assignment, verdict, evidence, feedback }, one entry per assign → work → review cycle. verdict stays "pending" until you have reviewed, then becomes "accepted" or "rejected". evidence is what YOU checked; feedback is what the worker must change.
- decisions: append-only log of significant choices (spec changes, scope cuts, tool choices), one line each. A patch replaces the whole array, so an entry you leave out leaves Σ: the answer names the entries that were dropped and task_history keeps their text. Append; do not rewrite what is already recorded.
- blockers: list of things preventing progress (empty when not blocked).
- next: { action, risk } — the very next concrete step and its risk level.`;

const SUPERVISE_LOOP: string = `The loop:
1. Write one assignment: small enough to review in one pass, specific about what "done" means and which files it touches.
2. Let the worker run it. Do not implement the assignment yourself — the worker producing the artifact is the point of the round.
3. Review the result yourself: read the files, run the checks, compare against the spec. Never accept on the worker's own claim.
4. Record verdict and evidence. When rejecting, write feedback the worker can act on without guessing, and say which part of the spec it violates.
5. Put the next assignment into next.action; update spec when the requirements themselves changed.

Domain rules enforced on every patch: a finished task cannot be reopened; "accepted" requires evidence; "rejected" requires feedback; only one round may be pending at a time; status "blocked" requires at least one blocker.

Risk note: launching the worker inside its own project is "safe". Editing user-level configuration, installing anything globally, and publishing anything are "external".`;

export const SUPERVISE_TASK_INSTRUCTIONS: string = composeProcedure(
  SUPERVISE_INTRO,
  SUPERVISE_STATE_DICT,
  RISK_RULES,
  PATCH_SEMANTICS,
  SUPERVISE_LOOP,
  STATE_HYGIENE,
);

export function superviseTaskInitialState(goal: string): SuperviseTaskState {
  return {
    goal,
    status: 'active',
    spec: '',
    worker: '',
    rounds: [],
    decisions: [],
    blockers: [],
    next: {
      action: 'Name the spec the worker follows, then write the first assignment',
      risk: 'safe',
    },
  };
}

/** Progress for list views: accepted rounds over all of them. */
export function superviseTaskProgress(state: StateDict): { done: number; total: number } {
  const rounds = state.rounds;
  if (!Array.isArray(rounds)) return { done: 0, total: 0 };
  let done = 0;
  for (const round of rounds) {
    if (isPlainObject(round) && round.verdict === 'accepted') done += 1;
  }
  return { done, total: rounds.length };
}

export function superviseTaskSkill(): Skill {
  // Object literal (not the interface-typed return of superviseTaskInitialState) so
  // TypeScript sees a fresh type assignable to the StateDict index signature.
  return {
    name: 'supervise-task',
    instructions: SUPERVISE_TASK_INSTRUCTIONS,
    schema: superviseTaskSchema,
    initialState: {
      goal: 'placeholder',
      status: 'active',
      spec: '',
      worker: '',
      rounds: [],
      decisions: [],
      blockers: [],
      next: {
        action: 'Name the spec the worker follows, then write the first assignment',
        risk: 'safe',
      },
    },
    guard: superviseTaskGuard,
    progress: superviseTaskProgress,
  };
}
