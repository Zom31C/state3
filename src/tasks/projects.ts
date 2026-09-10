import { resolve } from 'node:path';
import type { ProjectEntry, StoreResolver, TaskStorePort } from './ports.js';

/** Project names are typed by a model, so they stay short and shell-safe. */
export const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class UnknownProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownProjectError';
  }
}

function entry(name: string, dir: string, cwd: string): ProjectEntry {
  const trimmed = name.trim();
  if (!PROJECT_NAME.test(trimmed)) {
    throw new Error(
      `invalid project name "${name}": use lowercase letters, digits, "-" or "_", starting with a letter or digit`,
    );
  }
  if (dir.trim() === '') throw new Error(`project "${trimmed}" has an empty directory`);
  return { name: trimmed, rootDir: resolve(cwd, dir.trim()) };
}

/**
 * Parses declared project roots: `name=dir` pairs separated by `;` or newlines,
 * or a JSON object mapping names to directories. Relative directories resolve
 * against `cwd`.
 *
 * The declaration comes from the user's environment or host configuration, never
 * from the model: the model may only pick among the names declared here.
 */
export function parseProjectsSpec(spec: string, cwd: string = process.cwd()): ProjectEntry[] {
  const trimmed = spec.trim();
  if (trimmed === '') return [];

  const pairs: [string, string][] = [];
  if (trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(
        `SKILLSTATE_PROJECTS looks like JSON but does not parse: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('SKILLSTATE_PROJECTS as JSON must be an object of name -> directory');
    }
    for (const [name, dir] of Object.entries(parsed)) {
      if (typeof dir !== 'string') {
        throw new Error(`project "${name}" must map to a directory string`);
      }
      pairs.push([name, dir]);
    }
  } else {
    for (const part of trimmed.split(/[;\n]/)) {
      if (part.trim() === '') continue;
      const separator = part.indexOf('=');
      if (separator < 1) {
        throw new Error(`project declaration "${part.trim()}" must look like name=directory`);
      }
      pairs.push([part.slice(0, separator), part.slice(separator + 1)]);
    }
  }

  const entries: ProjectEntry[] = [];
  const seen = new Set<string>();
  for (const [name, dir] of pairs) {
    const project = entry(name, dir, cwd);
    if (seen.has(project.name)) throw new Error(`project "${project.name}" is declared twice`);
    seen.add(project.name);
    entries.push(project);
  }
  return entries;
}

/** Renders declared projects for diagnostics and error messages. */
export function describeProjects(projects: readonly ProjectEntry[]): string {
  if (projects.length === 0) return 'none declared';
  return projects.map((project) => `${project.name} (${project.rootDir})`).join(', ');
}

/**
 * Resolves a project name to a store. Stores are created on first use and cached,
 * so a session supervising several projects opens each root once.
 */
export function createProjectResolver(
  primary: TaskStorePort,
  projects: readonly ProjectEntry[],
  openStore: (rootDir: string) => TaskStorePort,
): StoreResolver {
  const roots = new Map(projects.map((project) => [project.name, project.rootDir]));
  const opened = new Map<string, TaskStorePort>();

  return {
    resolve(project?: string): TaskStorePort {
      if (project === undefined || project.trim() === '') return primary;
      const name = project.trim();
      const rootDir = roots.get(name);
      if (rootDir === undefined) {
        throw new UnknownProjectError(
          `unknown project "${name}" — declared projects: ${describeProjects(projects)}`,
        );
      }
      const cached = opened.get(name);
      if (cached !== undefined) return cached;
      const store = openStore(rootDir);
      opened.set(name, store);
      return store;
    },
    projects: () => projects,
  };
}

/** Resolver for a single root: every call lands on the same store. */
export function singleStoreResolver(store: TaskStorePort): StoreResolver {
  return createProjectResolver(store, [], () => store);
}
