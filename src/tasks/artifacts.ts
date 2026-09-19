import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { isPlainObject } from '../core/state.js';
import type { StateDict } from '../core/types.js';

/** How many missing paths one answer names before the list stops being readable. */
const REPORT_LIMIT = 5;

/** A key that ends in a file extension, or in a separator: what a path looks like. */
const PATH_LIKE = /(^|[\\/])[^\\/]*\.[A-Za-z0-9]{1,10}$|[\\/]$/;

/**
 * True for an artifact key that claims a place in this project's tree.
 *
 * `artifacts` is a map from a resource to a line about it, and a resource is not always a
 * file: a knowledge-base page, an external repository, a deployed URL and a note all live
 * there. Only the keys that look like paths are checked, so a page id or a sentence in the
 * user's language is never reported as a missing file.
 */
export function isPathLikeArtifact(key: string): boolean {
  if (key.includes('://')) return false;
  if (isAbsolute(key)) return true;
  return PATH_LIKE.test(key);
}

/**
 * The artifact keys that look like paths and are not on disk, or an empty list.
 *
 * A warning, never a refusal: Σ says what the agent produced, and refusing a patch because
 * a file was moved a moment later would block the record of that very move. But a path with
 * a typo makes Σ claim a file that does not exist, and the only moment that is cheap to
 * catch is the write — later, nothing distinguishes it from a file that was deleted.
 */
export function missingArtifactPaths(state: StateDict, projectDir: string): string[] {
  const artifacts = state.artifacts;
  if (!isPlainObject(artifacts)) return [];

  const missing: string[] = [];
  for (const key of Object.keys(artifacts)) {
    if (!isPathLikeArtifact(key)) continue;
    const found = isAbsolute(key) ? existsSync(key) : existsSync(join(projectDir, key));
    if (found) continue;
    missing.push(key);
    if (missing.length >= REPORT_LIMIT) break;
  }
  return missing;
}

/** The lines a patch answer adds for artifacts it could not find; empty when all were. */
export function artifactWarnings(missing: readonly string[]): string[] {
  if (missing.length === 0) return [];
  const more = missing.length >= REPORT_LIMIT ? ' (the first few)' : '';
  return [
    `Note: artifact path${missing.length === 1 ? '' : 's'} not found in the project${more}: ` +
      missing.map((key) => `"${key}"`).join(', ') +
      '. Σ now claims a file that is not there — fix the key if it is a typo. An artifact may ' +
      'also name a page, a URL or a resource outside this tree; ignore this if it does.',
  ];
}
