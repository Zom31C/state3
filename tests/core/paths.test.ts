import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STATE_DIRNAME, projectDirOf } from '../../src/core/paths.js';

const project = join(tmpdir(), 'skillstate-project');

describe('projectDirOf', () => {
  it('takes the project a conventional state root belongs to', () => {
    expect(projectDirOf(join(project, STATE_DIRNAME))).toBe(resolve(project));
  });

  it('takes a root pointed elsewhere as the project itself', () => {
    // SKILLSTATE_STATE_DIR and a declared project root a state anywhere; its parent is
    // somebody else's tree, so anchoring records to it would be worse than not anchoring.
    expect(projectDirOf(project)).toBe(resolve(project));
    expect(projectDirOf(join(project, 'state'))).toBe(resolve(join(project, 'state')));
  });

  it('resolves a relative root against the working directory', () => {
    expect(projectDirOf(STATE_DIRNAME)).toBe(resolve(process.cwd()));
  });
});
