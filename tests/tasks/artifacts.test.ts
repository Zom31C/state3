import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StateDict } from '../../src/core/types.js';
import {
  artifactWarnings,
  isPathLikeArtifact,
  missingArtifactPaths,
} from '../../src/tasks/artifacts.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'state3-artifacts-'));
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'reader.ts'), 'export const reader = 1;\n', 'utf8');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function state(artifacts: Record<string, string>): StateDict {
  return { goal: 'g', artifacts } as unknown as StateDict;
}

describe('isPathLikeArtifact', () => {
  it('takes keys that claim a place in the tree', () => {
    for (const key of [
      'src/reader.ts',
      'src/',
      'tools\\check.ps1',
      'D:\\Projects\\worker',
      '.qwen/tmp/',
    ]) {
      expect(isPathLikeArtifact(key), key).toBe(true);
    }
  });

  it('leaves the keys that name something else alone', () => {
    // An artifact is also a page, a repository, a URL or a note in the user's language;
    // reporting those as missing files would make the warning noise.
    for (const key of [
      'документация',
      'tests',
      'git state3',
      'github.com/Zom31C/state3',
      'https://example.com/report.html',
      'Σ task-mabc1234-xyz9',
    ]) {
      expect(isPathLikeArtifact(key), key).toBe(false);
    }
  });
});

describe('missingArtifactPaths', () => {
  it('reports a path-like key that is not on disk and keeps the one that is', () => {
    const missing = missingArtifactPaths(
      state({ 'src/reader.ts': 'the reader', 'src/writer.ts': 'the writer' }),
      dir,
    );

    expect(missing).toEqual(['src/writer.ts']);
  });

  it('says nothing for a state whose keys are not paths', () => {
    expect(missingArtifactPaths(state({ документация: 'INTEGRATION.md §11' }), dir)).toEqual([]);
    expect(missingArtifactPaths({ goal: 'g' } as StateDict, dir)).toEqual([]);
  });

  it('accepts a directory and an absolute path', () => {
    expect(missingArtifactPaths(state({ 'src/': 'the sources' }), dir)).toEqual([]);
    expect(missingArtifactPaths(state({ [path.join(dir, 'src', 'reader.ts')]: 'x' }), dir)).toEqual(
      [],
    );
    expect(missingArtifactPaths(state({ [path.join(dir, 'src', 'absent.ts')]: 'x' }), dir)).toEqual(
      [path.join(dir, 'src', 'absent.ts')],
    );
  });

  it('stops after a few, so the note cannot outgrow the answer it is attached to', () => {
    const artifacts: Record<string, string> = {};
    for (let index = 0; index < 9; index += 1) artifacts[`src/absent${index}.ts`] = 'x';

    expect(missingArtifactPaths(state(artifacts), dir)).toHaveLength(5);
  });
});

describe('artifactWarnings', () => {
  it('is empty when every path was found', () => {
    expect(artifactWarnings([])).toEqual([]);
  });

  it('names the paths, says what Σ now claims, and leaves room for a non-file artifact', () => {
    const [line] = artifactWarnings(['src/writer.ts']);

    expect(line).toContain('not found in the project');
    expect(line).toContain('"src/writer.ts"');
    expect(line).toContain('claims a file that is not there');
    expect(line).toContain('ignore this if it does');
  });
});
