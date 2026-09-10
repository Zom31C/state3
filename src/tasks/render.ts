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
