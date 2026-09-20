import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StateDict } from '../../src/core/types.js';
import {
  artifactKeys,
  describeDrift,
  driftedArtifacts,
  driftWarnings,
  stampOnDisk,
} from '../../src/tasks/artifact-stamps.js';
import type { ArtifactStamp } from '../../src/tasks/artifact-stamps.js';
import { TaskStore } from '../../src/tasks/store.js';

let dir: string;
let store: TaskStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'skillstate-stamps-'));
  store = new TaskStore(dir);
});

afterEach(async () => {
  // The database file cannot be deleted on Windows while a connection holds it.
  store.close();
  await rm(dir, { recursive: true, force: true });
});

/** Σ with the artifacts of a dev-task; the rest is what the schema requires. */
function state(artifacts: Record<string, string>): StateDict {
  return {
    goal: 'g',
    status: 'active',
    plan: [],
    artifacts,
    verifications: [],
    decisions: [],
    blockers: [],
    next: { action: 'continue', risk: 'safe' },
  } as unknown as StateDict;
}

function stamp(key: string, overrides: Partial<ArtifactStamp> = {}): ArtifactStamp {
  return { key, mtimeMs: 1_000, size: 10, at: '2026-09-19T21:40:00.000Z', ...overrides };
}

describe('artifactKeys', () => {
  it('keeps the keys that claim a place in the tree and drops the rest', () => {
    const keys = artifactKeys(
      state({
        'src/reader.ts': 'the reader',
        '.qwen/tmp/': 'scratch',
        'D:\\other\\project\\car.cs': 'somewhere else',
        'github.com/Zom31C/skillState': 'a remote',
        документация: 'a note in the user language',
      }),
    );

    expect(keys).toEqual(['src/reader.ts', '.qwen/tmp/', 'D:\\other\\project\\car.cs']);
  });

  it('is empty for a skill whose Σ has no artifacts', () => {
    expect(artifactKeys({ goal: 'g', rounds: [] } as unknown as StateDict)).toEqual([]);
  });
});

describe('stampOnDisk', () => {
  it('stamps a file with the two numbers that move when its contents do', async () => {
    await writeFile(path.join(dir, 'a.ts'), 'one');

    const first = stampOnDisk(path.join(dir, 'a.ts'));
    expect(first).not.toBeNull();
    expect(first?.size).toBe(3);

    await writeFile(path.join(dir, 'a.ts'), 'one two three');
    const second = stampOnDisk(path.join(dir, 'a.ts'));

    expect(second?.size).toBe(13);
    // Two writes can land in the same millisecond, which is why the size is compared too.
    expect(second?.mtimeMs ?? 0).toBeGreaterThanOrEqual(first?.mtimeMs ?? 0);
  });

  it('stamps nothing for a directory, whose mtime moves whenever anything is written near it', async () => {
    expect(stampOnDisk(dir)).toBeNull();
  });

  it('stamps nothing for a path that is not there', () => {
    expect(stampOnDisk(path.join(dir, 'absent.ts'))).toBeNull();
  });
});

describe('driftedArtifacts', () => {
  it('is empty when the disk still agrees with the stamp', async () => {
    await writeFile(path.join(dir, 'a.ts'), 'one');
    const onDisk = stampOnDisk(path.join(dir, 'a.ts'));
    if (onDisk === null) throw new Error('unreachable');

    const drifted = driftedArtifacts(
      state({ 'a.ts': 'the reader' }),
      new Map([['a.ts', stamp('a.ts', onDisk)]]),
      dir,
    );

    expect(drifted).toEqual([]);
  });

  it('reports a file whose contents changed, and how long after Σ was written', async () => {
    await writeFile(path.join(dir, 'a.ts'), 'one');
    const onDisk = stampOnDisk(path.join(dir, 'a.ts'));
    if (onDisk === null) throw new Error('unreachable');

    const drifted = driftedArtifacts(
      state({ 'a.ts': 'the reader' }),
      new Map([
        [
          'a.ts',
          stamp('a.ts', {
            // An older size as well as an older mtime: the stamp is what Σ was written against.
            mtimeMs: onDisk.mtimeMs - 90 * 60_000,
            size: onDisk.size,
            at: new Date(onDisk.mtimeMs - 120 * 60_000).toISOString(),
          }),
        ],
      ]),
      dir,
    );

    expect(drifted).toHaveLength(1);
    expect(drifted[0]?.minutesAfter).toBe(120);
    expect(drifted[0]?.modifiedAt).toBe(
      new Date(onDisk.mtimeMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    );
  });

  it('reports a file that is gone, which is the same kind of surprise', () => {
    const drifted = driftedArtifacts(
      state({ 'absent.ts': 'the reader' }),
      new Map([['absent.ts', stamp('absent.ts')]]),
      dir,
    );

    expect(drifted).toEqual([
      {
        key: 'absent.ts',
        recordedAt: '2026-09-19T21:40:00.000Z',
        modifiedAt: null,
        minutesAfter: null,
      },
    ]);
  });

  it('says nothing about a key with no stamp, which a build before stamps left behind', () => {
    expect(driftedArtifacts(state({ 'a.ts': 'the reader' }), new Map(), dir)).toEqual([]);
  });

  it('omits the minutes when the file is older than the patch that recorded it', async () => {
    // A checkout restores an older mtime: the contents still differ, so it is still drift,
    // but "N min later" would be a lie about the direction.
    const file = path.join(dir, 'a.ts');
    await writeFile(file, 'restored');
    const older = new Date(Date.parse('2026-09-19T20:00:00.000Z'));
    await utimes(file, older, older);

    const drifted = driftedArtifacts(
      state({ 'a.ts': 'the reader' }),
      new Map([['a.ts', stamp('a.ts', { mtimeMs: 1, size: 99 })]]),
      dir,
    );

    expect(drifted[0]?.minutesAfter).toBeNull();
    expect(drifted[0]?.modifiedAt).toBe('2026-09-19T20:00:00Z');
  });
});

describe('driftWarnings', () => {
  it('is empty when nothing drifted', () => {
    expect(driftWarnings([])).toEqual([]);
  });

  it('names the file, when Σ was written and when the file moved', () => {
    const lines = driftWarnings([
      {
        key: 'scenes/Car.tscn',
        recordedAt: '2026-09-19T21:40:00.000Z',
        modifiedAt: '2026-09-19T23:43:12.000Z',
        minutesAfter: 123,
      },
    ]);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Artifacts changed on disk since Σ was last written');
    expect(lines[0]).toContain('2026-09-19T21:40:00Z');
    expect(lines[0]).toContain('scenes/Car.tscn (modified 2026-09-19T23:43:12Z, 123 min after');
    expect(lines[0]).toContain('git status');
  });

  it('names the first few drifted files and counts the rest', () => {
    const drifted = Array.from({ length: 7 }, (_, index) => ({
      key: `src/file${index}.ts`,
      recordedAt: '2026-09-19T21:40:00.000Z',
      modifiedAt: null,
      minutesAfter: null,
    }));

    const lines = driftWarnings(drifted);

    expect(lines[0]).toContain('and 2 more');
    expect(lines[0]).toContain('src/file4.ts (no longer on disk)');
    expect(lines[0]).not.toContain('src/file5.ts');
  });

  it('reads a file that is gone differently from one that moved', () => {
    expect(
      describeDrift({
        key: 'a.ts',
        recordedAt: 'x',
        modifiedAt: null,
        minutesAfter: null,
      }),
    ).toBe('a.ts (no longer on disk)');
  });
});

describe('TaskStore artifact stamps', () => {
  it('records a stamp when Σ is written, and reports nothing while the file stands', async () => {
    await writeFile(path.join(dir, 'a.ts'), 'one');
    const task = await store.start('Ship it');

    await store.patch({ artifacts: { 'a.ts': 'the reader' } }, task.meta.id);

    expect(await store.driftedArtifacts(task.meta.id)).toEqual([]);
  });

  it('reports a file changed by hand after the patch that recorded it', async () => {
    await writeFile(path.join(dir, 'a.ts'), 'one');
    const task = await store.start('Ship it');
    await store.patch({ artifacts: { 'a.ts': 'the reader' } }, task.meta.id);

    await writeFile(path.join(dir, 'a.ts'), 'one two three, edited by hand overnight');

    const drifted = await store.driftedArtifacts(task.meta.id);
    expect(drifted.map((item) => item.key)).toEqual(['a.ts']);
    expect(drifted[0]?.modifiedAt).not.toBeNull();
  });

  it("takes the stamp again on the next patch, so the agent's own edit is not drift", async () => {
    await writeFile(path.join(dir, 'a.ts'), 'one');
    const task = await store.start('Ship it');
    await store.patch({ artifacts: { 'a.ts': 'the reader' } }, task.meta.id);

    await writeFile(path.join(dir, 'a.ts'), 'one two three');
    // Any patch re-stamps: Σ was just written, so this is the tree it describes now.
    await store.patch({ decisions: ['edited the reader'] }, task.meta.id);

    expect(await store.driftedArtifacts(task.meta.id)).toEqual([]);
  });

  it('drops the stamp of an artifact that left Σ', async () => {
    await writeFile(path.join(dir, 'a.ts'), 'one');
    const task = await store.start('Ship it');
    await store.patch({ artifacts: { 'a.ts': 'the reader' } }, task.meta.id);
    await store.patch({ artifacts: { 'a.ts': null } }, task.meta.id);

    await writeFile(path.join(dir, 'a.ts'), 'changed after it left Σ');

    expect(await store.driftedArtifacts(task.meta.id)).toEqual([]);
  });

  it('stamps no directory, so a scratch folder full of new files is not drift', async () => {
    const scratch = path.join(dir, '.qwen', 'tmp');
    await mkdir(scratch, { recursive: true });
    const task = await store.start('Ship it');
    await store.patch({ artifacts: { '.qwen/tmp/': 'scratch' } }, task.meta.id);

    // Writing inside the folder moves its mtime, which says nothing about what Σ claims.
    await writeFile(path.join(scratch, 'probe.json'), '{}');

    expect(await store.driftedArtifacts(task.meta.id)).toEqual([]);
  });

  it('answers an empty list for a task that does not exist rather than throwing', async () => {
    expect(await store.driftedArtifacts('task-nope')).toEqual([]);
  });
});
