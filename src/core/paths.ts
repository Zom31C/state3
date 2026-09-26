import { basename, dirname, resolve } from 'node:path';

/** The directory a project's state lives in: every entry point defaults to it. */
export const STATE_DIRNAME = '.state3';

/**
 * The project a state root belongs to.
 *
 * A state root is `<project>/.state3` by convention, and everything anchored to the
 * project — the git commit a verification was recorded at, the files a page describes, the
 * paths its artifacts name — is resolved against the project, not against the state
 * directory. A root pointed somewhere else (`STATE3_STATE_DIR`, a declared project) is
 * taken as the project itself: there is no better guess, and guessing the parent of an
 * arbitrary directory would anchor records to a tree they have nothing to do with.
 */
export function projectDirOf(rootDir: string): string {
  const resolved = resolve(rootDir);
  return basename(resolved) === STATE_DIRNAME ? dirname(resolved) : resolved;
}
