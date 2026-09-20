import { execFileSync } from 'node:child_process';

/**
 * The git facts a state record is anchored to.
 *
 * A record that says "the checks passed" or "this page describes scripts/Car.cs" is only
 * true of the tree it was written against, and the tree moves. Stamping the commit is what
 * makes such a record checkable later — by a supervisor diffing a report, or by an agent
 * wondering whether the line numbers it was given still hold.
 *
 * Every function here returns null (or an empty answer) instead of throwing: git may be
 * missing, the project may not be a repository, and the working tree may be mid-rebase. A
 * state write must not fail because the project is not under version control, and a stamp
 * that could not be taken is recorded as absent rather than guessed.
 */

/** Long enough for a cold start on a network drive, short enough to never hold up a patch. */
const GIT_TIMEOUT_MS = 5000;

function git(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      // stderr is noise here: "not a git repository" is an answer this module reports as null.
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** The short hash of HEAD, or null when this directory has no repository to ask. */
export function gitHead(cwd: string): string | null {
  const head = git(cwd, ['rev-parse', '--short', 'HEAD']);
  // An empty repository has no HEAD, and git answers "HEAD" itself in some versions.
  if (head === null || head === '' || head === 'HEAD') return null;
  return head;
}

/**
 * How many commits a churn ranking looks at.
 *
 * A window rather than the whole history: the question is which files cost the most to
 * rediscover NOW, and a file last touched three years ago is not that. The bound is also
 * what keeps the answer cheap — one subprocess with a predictable amount of output, on a
 * call an agent makes once per session at most.
 */
export const CHURN_COMMIT_WINDOW = 200;

/**
 * Paths git would otherwise quote, so a knowledge base in the user's language matches the
 * tree: without this a file named `документация.md` is printed as `"\320\264..."`, which no
 * page body will ever contain.
 */
const UNQUOTED: readonly string[] = ['-c', 'core.quotePath=false'];

/** Every file this repository tracks, with `/` separators, or null when there is none. */
export function gitTrackedFiles(cwd: string): string[] | null {
  const out = git(cwd, [...UNQUOTED, 'ls-files']);
  if (out === null) return null;
  if (out === '') return [];
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * How many commits inside the last `window` touched each file, or null when there is no
 * repository to ask.
 *
 * Counted from one `git log` rather than one call per file: a project has hundreds of files
 * and a report that spent a subprocess on each would not be run twice.
 */
export function gitFileChurn(
  cwd: string,
  window: number = CHURN_COMMIT_WINDOW,
): Map<string, number> | null {
  const out = git(cwd, [...UNQUOTED, 'log', '-n', String(window), '--format=', '--name-only']);
  if (out === null) return null;

  const churn = new Map<string, number>();
  for (const line of out.split('\n')) {
    const file = line.trim();
    if (file === '') continue;
    churn.set(file, (churn.get(file) ?? 0) + 1);
  }
  return churn;
}

/** One commit that touched the given paths, and which of them it touched. */
export interface CommitTouch {
  commit: string;
  files: string[];
}

/**
 * The commits between `from` (exclusive) and HEAD that touched any of `paths`, oldest first,
 * with the touched files of each.
 *
 * Null when the question cannot be answered — `from` is not a commit this repository has,
 * the paths were never tracked, or there is no repository at all. A caller must read null as
 * "unknown", not as "nothing changed": the difference is the whole point of anchoring.
 */
export function gitCommitsTouching(
  cwd: string,
  from: string,
  paths: readonly string[],
): CommitTouch[] | null {
  if (paths.length === 0) return [];
  if (gitHead(cwd) === null) return null;

  const out = git(cwd, [
    'log',
    '--format=%h%x00',
    '--name-only',
    '--reverse',
    `${from}..HEAD`,
    '--',
    ...paths,
  ]);
  // A revision git does not know makes the whole range invalid, and "no changes since an
  // unknown commit" would be a lie in the shape of an answer.
  if (out === null) return null;
  if (out === '') return [];

  const touches: CommitTouch[] = [];
  for (const block of out.split('\n')) {
    const line = block.trim();
    if (line === '') continue;
    const at = line.indexOf('\u0000');
    if (at >= 0) {
      touches.push({ commit: line.slice(0, at), files: [] });
      continue;
    }
    touches[touches.length - 1]?.files.push(line);
  }
  return touches;
}
