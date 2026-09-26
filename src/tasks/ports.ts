import type { StateDict } from '../core/types.js';
import type { DriftedArtifact } from './artifact-stamps.js';
import type { HistoryEntry, PatchReport, StartOptions, StoredTask, TaskSummary } from './store.js';

/**
 * Structural port over the task store. The real `TaskStore` satisfies it, and a
 * fake can be substituted in tests without importing `../tasks/store.js` values.
 */
export interface TaskStorePort {
  /**
   * Absolute state directory. Surfaced in diagnostics because the host may spawn
   * the server outside the project, and an empty task list must not look the same
   * as "state is in the wrong place".
   */
  readonly rootDir?: string;
  start(goal: string, options?: StartOptions): Promise<StoredTask>;
  show(id?: string): Promise<StoredTask>;
  patch(patch: StateDict, id?: string, report?: PatchReport): Promise<StoredTask>;
  finish(summary: string, id?: string): Promise<StoredTask>;
  list(): Promise<TaskSummary[]>;
  history(id?: string, limit?: number): Promise<HistoryEntry[]>;
  activeId(): Promise<string | null>;
  /**
   * File artifacts whose file moved since Σ was last written. Optional because it is a
   * diagnostic: a store that cannot answer it costs a missing note, not a wrong one.
   */
  driftedArtifacts?(id?: string): Promise<DriftedArtifact[]>;
  /** Full procedure P for a task: its skill's instructions plus the notation appendix. */
  instructionsFor(task: StoredTask): string;
  /** Skills this store can create tasks for; optional so test fakes stay small. */
  skillNames?(): string[];
  /**
   * What carrying a pre-rename state root over did, or null. Optional for the same reason as
   * `driftedArtifacts`: an entry point that cannot report it loses one line, not any state.
   */
  carryOverNote?(): string | null;
}

/** A named state root besides the primary one. */
export interface ProjectEntry {
  name: string;
  rootDir: string;
}

/**
 * Chooses the store a call applies to. One session can read and patch tasks that
 * live in another project's root — that is how a supervising agent follows a
 * worker — but only roots declared up front are reachable, so a model can never
 * point the tools at an arbitrary directory.
 */
export interface StoreResolver {
  /** Store for `project`; the primary store when it is omitted. */
  resolve(project?: string): TaskStorePort;
  /** Declared projects, for diagnostics and error messages. */
  projects(): readonly ProjectEntry[];
}
