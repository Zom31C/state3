import { isPlainObject } from '../core/state.js';
import type { StateDict } from '../core/types.js';
import { notationReminder } from './notation.js';
import type { StoredTask } from './store.js';

/** Above this size Σ stops being an O(1) prompt component, so the agent is told to compress it. */
export const STATE_SIZE_HINT_CHARS = 4000;

export function stateSizeHint(state: unknown): string {
  const compact = JSON.stringify(state);
  if (compact.length <= STATE_SIZE_HINT_CHARS) return '';
  return (
    `Σ is ${compact.length} chars — compress it: keep only what future steps need ` +
    'and reduce finished work to its outcome.'
  );
}

/** Σ is domain state, so its status is read defensively: a foreign skill may name it differently. */
export function taskStatus(state: StateDict): string {
  return typeof state.status === 'string' && state.status !== '' ? state.status : 'unknown';
}

/** Task header plus the compact single-line Σ; shared by the MCP tools and the CLI. */
export function renderTaskHead(task: StoredTask): string {
  return [
    `Task ${task.meta.id} [${task.meta.skill}] (${taskStatus(task.state)}):`,
    JSON.stringify(task.state),
    notationReminder(task.meta.notation),
    stateSizeHint(task.state),
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** A trimmed string, or null when this skill has no such field or wrote something else. */
function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** The one plan item in flight, notes included — a delegated agent must not redo it. */
function inFlight(plan: unknown): string | null {
  if (!Array.isArray(plan)) return null;
  for (const item of plan) {
    if (!isPlainObject(item) || item.status !== 'in_progress') continue;
    const what = text(item.task);
    if (what === null) continue;
    const notes = text(item.notes);
    return notes === null ? what : `${what} — ${notes}`;
  }
  return null;
}

/** Blockers as one line, because a subagent that walks into one repeats the stall. */
function blocked(blockers: unknown): string | null {
  if (!Array.isArray(blockers)) return null;
  const lines = blockers.map(text).filter((line): line is string => line !== null);
  return lines.length === 0 ? null : lines.join('; ');
}

/**
 * The few lines a delegated subagent needs: what the project is doing, which step is in
 * flight, what comes next, and what is blocking. Not Σ.
 *
 * A subagent starts with no transcript, so without this it does the two things an external
 * state exists to prevent — it starts a second task, or it redoes a finished step. But it
 * does not need the whole state, and Σ re-sent on every turn of a cheap agent is exactly the
 * recurring cost this project exists to remove: the full state and the procedure are one
 * `task_show` away, which is also the only way to get the skill's own rules.
 *
 * Fields are read defensively, as everywhere Σ is rendered: the state belongs to a skill, and
 * only `goal`, `status`, `blockers` and `next` are common to the ones this runtime ships. A
 * line whose field this skill does not have is simply absent.
 */
export function renderTaskBrief(task: StoredTask): string {
  const state = task.state;
  const goal = text(state.goal);
  const current = inFlight(state.plan);
  const lines = [
    `Task ${task.meta.id} [${task.meta.skill}] (${taskStatus(state)})`,
    goal === null ? '' : `goal: ${goal}`,
    current === null ? '' : `in flight: ${current}`,
  ];

  const next = state.next;
  if (isPlainObject(next)) {
    const action = text(next.action);
    const risk = text(next.risk);
    if (action !== null) {
      lines.push(risk === null ? `next: ${action}` : `next: ${action} [risk: ${risk}]`);
    }
  }

  const blockers = blocked(state.blockers);
  if (blockers !== null) lines.push(`blocked: ${blockers}`);

  return lines.filter((line) => line !== '').join('\n');
}
