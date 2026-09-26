import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { gitCommitsTouching, gitHead } from '../../src/core/git.js';

/** The repository this build is compiled from, when the tests run inside one. */
const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const isRepo = existsSync(join(repoRoot, '.git'));

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'state3-git-'));
}

describe('gitHead', () => {
  it('is null outside a repository, and never throws', () => {
    const dir = tempDir();
    try {
      expect(gitHead(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!isRepo)('reads the short hash of the repository this build lives in', () => {
    expect(gitHead(repoRoot)).toMatch(/^[0-9a-f]{7,64}$/);
  });
});

describe('gitCommitsTouching', () => {
  it('answers an empty list when no path was asked for', () => {
    expect(gitCommitsTouching(repoRoot, 'HEAD', [])).toEqual([]);
  });

  it.skipIf(!isRepo)('reports no change between a commit and itself', () => {
    const head = gitHead(repoRoot);
    expect(head).not.toBeNull();
    if (head === null) return;
    expect(gitCommitsTouching(repoRoot, head, ['package.json'])).toEqual([]);
  });

  it.skipIf(!isRepo)('names the commits that touched a file since an earlier one', () => {
    // The commit before HEAD, and a file the repository has always had: whatever the
    // answer, it must be a list of commits with files, not an error.
    const head = gitHead(repoRoot);
    if (head === null) return;
    const touches = gitCommitsTouching(repoRoot, `${head}~1`, ['package.json']);
    expect(touches).not.toBeNull();
    expect(Array.isArray(touches)).toBe(true);
    for (const touch of touches ?? []) {
      expect(touch.commit).toMatch(/^[0-9a-f]{7,64}$/);
      expect(touch.files).toContain('package.json');
    }
  });

  it.skipIf(!isRepo)(
    'is null for a revision the repository does not have, not "nothing changed"',
    () => {
      expect(gitCommitsTouching(repoRoot, 'deadbeefdeadbeef', ['package.json'])).toBeNull();
    },
  );
});
