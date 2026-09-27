import { isPlainObject } from '../core/state.js';
import type { StateDict, StateValue } from '../core/types.js';
import { notationReminder } from './notation.js';
import { queueOrder } from './store.js';
import type { Handover, StoredTask, TaskSummary } from './store.js';

/** Above this size Σ stops being an O(1) prompt component, so the agent is told to compress it. */
export const STATE_SIZE_HINT_CHARS = 4000;

/**
 * Above this size an injected Σ is cut down to the step in flight, `next` and `blockers`.
 *
 * Σ is injected on every prompt, so a state that grew past this is a tax on every turn of
 * the task, and "compress it" alone does not pay for itself: the agent that could shrink Σ
 * mid-step usually does not. What the injection keeps is what the next action can be read
 * from; everything else is one `task_show` away, and the note says exactly what was left out
 * and how big the state that holds it is.
 */
export const STATE_DELTA_THRESHOLD_CHARS = 6000;

export function stateSizeHint(state: unknown): string {
  const compact = JSON.stringify(state);
  if (compact.length <= STATE_SIZE_HINT_CHARS) return '';
  return (
    `Σ is ${compact.length} chars — compress it: keep only what future steps need, ` +
    'reduce finished work to its outcome, and archive the plan steps whose outcome is ' +
    'already in decisions ({"plan[0].archived":true}) so the injection stops carrying them.'
  );
}

/** Σ is domain state, so its status is read defensively: a foreign skill may name it differently. */
export function taskStatus(state: StateDict): string {
  return typeof state.status === 'string' && state.status !== '' ? state.status : 'unknown';
}

export interface RenderOptions {
  /**
   * Render what a prompt carries, rather than what a read answers. An injected Σ drops the
   * plan steps marked `archived` and, above `STATE_DELTA_THRESHOLD_CHARS`, everything but the
   * step in flight. A tool answer keeps the whole state: it is the confirmation of a write,
   * and `task_show` is the call whose contract is to return all of Σ.
   */
  injected?: boolean;
}

/** Σ as a prompt carries it, plus the lines that say what was left out of it. */
export interface InjectedView {
  state: StateDict;
  notes: string[];
  /** True when the notes already carry the size complaint, so the plain hint stays out. */
  reportsSize: boolean;
  /** Which cut was applied, and the two sizes that decided it. */
  mode: InjectionMode;
}

/**
 * The cut an injection applied, with both sizes that could have decided it.
 *
 * Reported because the two disagree in the case an agent cannot resolve on its own: Σ can be
 * over the budget while what the prompt carries is under it, because archiving plan steps
 * already paid for the difference. Reading "Σ is 7294 chars" next to a full injection looks
 * like a broken gate, and the only way to tell a measured decision from a bug is to see the
 * number the gate actually compared.
 */
export interface InjectionMode {
  /** `full` carries every field of Σ; `delta` carries the step in flight, next and blockers. */
  kind: 'full' | 'delta';
  /** Characters of Σ as stored — what the size hint complains about. */
  total: number;
  /** Characters of the state this injection carries — what the budget measures. */
  injected: number;
  /** Archived plan steps dropped before measuring. */
  archived: number;
}

/** The one line that says which mode was applied when the two sizes straddle the budget. */
function modeNote(mode: InjectionMode): string {
  return (
    `Injection mode: ${mode.kind} — Σ is ${mode.total} chars and this prompt carries ` +
    `${mode.injected} of them; the ${STATE_DELTA_THRESHOLD_CHARS}-char budget measures what a ` +
    'prompt carries, not all of Σ, and above it only the step in flight, next and blockers ' +
    'are injected.'
  );
}

/** Σ without the plan steps marked archived, and how many that removed. */
export function dropArchivedSteps(state: StateDict): { state: StateDict; archived: number } {
  const plan = state.plan;
  if (!Array.isArray(plan)) return { state, archived: 0 };
  const kept = plan.filter((item) => !(isPlainObject(item) && item.archived === true));
  const archived = plan.length - kept.length;
  // The array itself is never rewritten in Σ: an archived step keeps its index and its id,
  // so a path key written before the archiving still addresses the same step afterwards.
  if (archived === 0) return { state, archived: 0 };
  return { state: { ...state, plan: kept }, archived };
}

/** How many entries a field holds, whether it is an array or a map; 0 for anything else. */
function sizeOf(state: StateDict, field: string): number {
  const value = state[field];
  if (Array.isArray(value)) return value.length;
  if (isPlainObject(value)) return Object.keys(value).length;
  return 0;
}

/** Plan items counted by status, as "5 done, 2 pending": what a cut injection still owes. */
function planCounts(plan: readonly StateValue[]): string {
  const counts = new Map<string, number>();
  for (const item of plan) {
    if (!isPlainObject(item)) continue;
    const status = typeof item.status === 'string' && item.status !== '' ? item.status : 'unknown';
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return [...counts.entries()].map(([status, count]) => `${count} ${status}`).join(', ');
}

/**
 * The injected view of Σ: archived steps out, and above the threshold only the delta.
 *
 * The budget is measured against what the prompt would actually carry, that is after the
 * archived steps are out: archiving is the cheap cut and it is the one the agent was already
 * asked for, so a state it brought back under the budget needs no second cut hiding the
 * artifacts and decisions the next step may read. Both cuts are reported in the same breath
 * as the state, because an injection that quietly held less than Σ would be worse than a
 * large one: a resumed session reads this text as the authoritative record of its progress,
 * so it has to be told what it is NOT seeing.
 */
export function injectedView(state: StateDict): InjectedView {
  const kept = dropArchivedSteps(state);
  const archivedNote =
    kept.archived === 0
      ? []
      : [
          `+${kept.archived} archived plan step(s) left out of this injection — task_show lists every one.`,
        ];

  const total = JSON.stringify(state).length;
  const injected = JSON.stringify(kept.state).length;
  const mode: InjectionMode = {
    kind: injected <= STATE_DELTA_THRESHOLD_CHARS ? 'full' : 'delta',
    total,
    injected,
    archived: kept.archived,
  };

  if (mode.kind === 'full') {
    // Σ over the budget while the prompt is under it is the one case that reads as a broken
    // gate from the inside, so it is the only case that costs a line to explain itself.
    const straddles = total > STATE_DELTA_THRESHOLD_CHARS;
    return {
      state: kept.state,
      notes: straddles ? [...archivedNote, modeNote(mode)] : archivedNote,
      reportsSize: false,
      mode,
    };
  }

  const plan = Array.isArray(kept.state.plan) ? kept.state.plan : [];
  const inFlight = plan.filter((item) => isPlainObject(item) && item.status === 'in_progress');
  const leftOutSteps = plan.filter((item) => !inFlight.includes(item));
  const delta: StateDict = {};
  for (const field of ['goal', 'status', 'blockers', 'next'] as const) {
    if (kept.state[field] !== undefined) delta[field] = kept.state[field];
  }
  if (inFlight.length > 0) delta.plan = inFlight;

  const leftOut = [
    leftOutSteps.length > 0
      ? `${leftOutSteps.length} plan step(s) (${planCounts(leftOutSteps)})`
      : null,
    sizeOf(kept.state, 'artifacts') > 0 ? `${sizeOf(kept.state, 'artifacts')} artifacts` : null,
    sizeOf(kept.state, 'decisions') > 0 ? `${sizeOf(kept.state, 'decisions')} decisions` : null,
    sizeOf(kept.state, 'verifications') > 0
      ? `${sizeOf(kept.state, 'verifications')} verifications`
      : null,
  ].filter((entry): entry is string => entry !== null);

  return {
    state: delta,
    notes: [
      `Injection mode: delta — Σ is ${total} chars, over the ${STATE_DELTA_THRESHOLD_CHARS}-char ` +
        'budget for what one prompt carries, so this injection carries only the step in flight, ' +
        `next and blockers — left out: ${leftOut.length === 0 ? 'nothing else' : leftOut.join(', ')}` +
        `${kept.archived === 0 ? '' : `, plus ${kept.archived} archived step(s)`}. ` +
        'task_show returns all of it; compress Σ so the injection can carry it again.',
    ],
    reportsSize: true,
    mode,
  };
}

/** What one top-level field of Σ costs, as `task_show {"view":"size"}` reports it. */
export interface FieldSize {
  field: string;
  /** Characters the field takes inside Σ, its key included. */
  chars: number;
  /** Items of an array or keys of a map; null for a scalar field. */
  entries: number | null;
}

/**
 * Every field of Σ with its size, largest first.
 *
 * "Compress it" without a breakdown is an invitation to rewrite the state on guesswork, and
 * a rewrite is the most expensive thing an agent can do to Σ: it retypes what it was trying
 * to shorten. Naming the field that costs most turns that into one targeted edit.
 */
export function stateSizes(state: StateDict): FieldSize[] {
  const sizes: FieldSize[] = [];
  for (const [field, value] of Object.entries(state)) {
    sizes.push({
      field,
      chars: `${JSON.stringify(field)}:${JSON.stringify(value)}`.length,
      entries: Array.isArray(value)
        ? value.length
        : isPlainObject(value)
          ? Object.keys(value).length
          : null,
    });
  }
  return sizes.sort((a, b) => b.chars - a.chars || (a.field < b.field ? -1 : 1));
}

/** The size report: what Σ costs in total and which field to shorten first. */
export function renderStateSize(state: StateDict): string {
  const sizes = stateSizes(state);
  const total = JSON.stringify(state).length;
  const width = sizes.reduce((widest, size) => Math.max(widest, size.field.length), 0);

  const lines = sizes.map((size) => {
    const share = total === 0 ? 0 : Math.round((size.chars / total) * 100);
    const entries = size.entries === null ? '' : `, ${size.entries} item(s)`;
    return `- ${size.field.padEnd(width)} ${String(size.chars).padStart(6)} chars (${String(share).padStart(3)}%${entries})`;
  });

  return [
    `Σ is ${total} chars over ${sizes.length} field(s), largest first:`,
    ...lines,
    'Shorten the top of this list: a field earns its size only if the next step reads it, and ' +
      'Σ is carried on every prompt of this task.',
    'Archiving a finished plan step ({"plan[0].archived":true}) leaves it in Σ but drops it ' +
      'from the injection; task_show {"view":"state"} reads Σ itself.',
  ].join('\n');
}

/** Σ whole, as a tool answer carries it: nothing cut, so both sizes are the same. */
function wholeView(state: StateDict): InjectedView {
  const total = JSON.stringify(state).length;
  return {
    state,
    notes: [],
    reportsSize: false,
    mode: { kind: 'full', total, injected: total, archived: 0 },
  };
}

/** Task header plus the compact single-line Σ; shared by the MCP tools and the CLI. */
export function renderTaskHead(task: StoredTask, options: RenderOptions = {}): string {
  const view: InjectedView =
    options.injected === true ? injectedView(task.state) : wholeView(task.state);

  return [
    `Task ${task.meta.id} [${task.meta.skill}] (${taskStatus(view.state)}):`,
    JSON.stringify(view.state),
    ...view.notes,
    notationReminder(task.meta.notation),
    // The hint is about the stored Σ, not about the view: compressing a rendering would
    // change nothing on disk, and the delta view already said how big the state is.
    view.reportsSize ? '' : stateSizeHint(task.state),
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

/**
 * A task's place in the tree changed, as the sentence both entry points print.
 *
 * One wording for the MCP answer and the CLI because the fact is the same, and each surface adds
 * its own pointer to the tree afterwards. Naming both ends is what makes a wrong id visible
 * while it is still cheap to undo: Σ cannot show the move, since the parent is a column.
 */
export function describeMove(move: { from: string | null; to: string | null }): string {
  if (move.to === null) return `Moved out of ${move.from ?? 'its decomposition'} into a root task`;
  if (move.from === null) return `Filed under ${move.to} as a subtask`;
  return `Moved from ${move.from} under ${move.to}`;
}

/**
 * The queue moved on to another task, as the sentence both entry points print.
 *
 * Shared for the reason `describeMove` is: one event, one wording, and each surface adds its own
 * pointer to the read that follows. Naming the goal and not just the id is what lets the caller
 * tell a handover from a promotion of the wrong piece before it starts working on it.
 */
export function describeHandover(next: Handover): string {
  return `Handed over to ${next.id} — "${next.goal}"`;
}

/**
 * One task's decomposition: the task itself, then each descendant behind its parent.
 *
 * Widened one level per pass until the set stops growing, so a cycle in `parent` — corrupt data,
 * not a state any sequence of calls can produce — costs one extra pass instead of an endless
 * walk. Order comes from the rows, which a listing already carries newest first; siblings are
 * put back into the order they were split out of, because that is the order the work reads in.
 */
export function subtreeRows(rows: readonly TaskSummary[], id: string): TaskSummary[] {
  const wanted = new Set<string>([id]);
  for (;;) {
    const before = wanted.size;
    for (const row of rows) {
      if (row.parent !== null && wanted.has(row.parent)) wanted.add(row.id);
    }
    if (wanted.size === before) break;
  }
  return rows.filter((row) => wanted.has(row.id));
}

/** One row of a listing, with the depth it sits at in the decomposition. */
export interface TreeRow {
  row: TaskSummary;
  depth: number;
}

/**
 * The rows in tree order: each task behind the one it was split out of, siblings in the order
 * they were split.
 *
 * Built from `parent` and `queueOrder` rather than from a stored depth, because the rows are
 * already in hand and a decomposition is a handful of levels deep. An orphan — a parent this list
 * does not hold, which is what a task whose Σ this runtime cannot validate looks like from here
 * — is printed as a root instead of disappearing: hiding a task is worse than misplacing one. A
 * cycle leaves its tasks unvisited by the walk, and they are appended flat at the end, because
 * "every task is in the listing" is the one property it owes whatever the tree looks like.
 */
export function treeOrder(rows: readonly TaskSummary[]): TreeRow[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const childrenOf = new Map<string, TaskSummary[]>();
  const roots: TaskSummary[] = [];
  for (const row of rows) {
    // Not its own parent: a self-referencing row is corrupt data, and treating it as a root
    // keeps it visible instead of making the walk below loop on it.
    if (row.parent !== null && row.parent !== row.id && byId.has(row.parent)) {
      const siblings = childrenOf.get(row.parent) ?? [];
      siblings.push(row);
      childrenOf.set(row.parent, siblings);
    } else {
      roots.push(row);
    }
  }
  for (const siblings of childrenOf.values()) siblings.sort(queueOrder);

  const out: TreeRow[] = [];
  const seen = new Set<string>();
  const walk = (row: TaskSummary, depth: number): void => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    out.push({ row, depth });
    for (const child of childrenOf.get(row.id) ?? []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push({ row, depth: 0 });
  }
  return out;
}

/** The task list as the tree it is, in the fixed-width columns the CLI prints. */
export function formatTaskList(rows: readonly TaskSummary[]): string {
  if (rows.length === 0) return 'no tasks';
  return treeOrder(rows)
    .map(({ row, depth }) => {
      const indent = depth === 0 ? '' : `${'  '.repeat(depth)}- `;
      const split =
        row.subtasks === 0
          ? ''
          : `  (${row.subtasks} subtask${row.subtasks === 1 ? '' : 's'}, ${row.openSubtasks} open)`;
      return (
        `${indent}${row.id}  ${row.skill.padEnd(14)}  ${row.status.padEnd(7)}  ` +
        `${row.progressDone}/${row.progressTotal}  ${row.goal}${split}`
      );
    })
    .join('\n');
}
