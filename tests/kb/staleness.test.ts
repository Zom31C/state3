import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PageStore } from '../../src/kb/store.js';
import { TaskStore } from '../../src/tasks/store.js';

/**
 * Anchoring against a real repository.
 *
 * The point of `sourceCommit` is a claim that can be checked, so the check is tested the way
 * it runs: a working tree, two commits, and a page written between them. A fake git would
 * only test that the store repeats what it was told.
 */
let project: string;
let tasks: TaskStore;
let pages: PageStore;

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: project,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/** Writes a file and commits it, returning the short hash the page will be anchored to. */
async function commit(file: string, contents: string, message: string): Promise<string> {
  await mkdir(path.dirname(path.join(project, file)), { recursive: true });
  await writeFile(path.join(project, file), contents, 'utf8');
  git('add', file);
  git('-c', 'user.email=test@state3', '-c', 'user.name=test', 'commit', '-q', '-m', message);
  return git('rev-parse', '--short', 'HEAD');
}

const carPage = {
  id: 'car-api',
  kind: 'feature' as const,
  title: 'Car API',
  summary: 'What the controller exposes.',
};

beforeEach(async () => {
  project = await mkdtemp(path.join(tmpdir(), 'state3-stale-'));
  git('init', '-q');
  tasks = new TaskStore(path.join(project, '.state3'));
  pages = new PageStore(tasks);
});

afterEach(async () => {
  tasks.close();
  await rm(project, { recursive: true, force: true });
});

describe('a page anchored to a repository', () => {
  it('records the commit it was written at and the files it names', async () => {
    const head = await commit('scripts/Car.cs', 'class Car {}\n', 'add the car');

    const stored = pages.put({ ...carPage, body: 'The controller is scripts/Car.cs:1-3.' });

    expect(stored.sourceCommit).toBe(head);
    expect(stored.sourceFiles).toEqual(['scripts/Car.cs']);
    expect(pages.freshness('car-api')).toEqual({
      commit: head,
      files: ['scripts/Car.cs'],
      changed: [],
    });
  });

  it('names the commits that moved the file a page describes', async () => {
    const written = await commit('scripts/Car.cs', 'class Car {}\n', 'add the car');
    pages.put({ ...carPage, body: 'Speed is set in scripts/Car.cs:2.' });
    const moved = await commit('scripts/Car.cs', 'class Car {\n  int speed;\n}\n', 'add speed');

    const fresh = pages.freshness('car-api');

    expect(fresh?.commit).toBe(written);
    expect(fresh?.changed).toEqual([{ commit: moved, files: ['scripts/Car.cs'] }]);
  });

  it('leaves a page alone when the commits touched other files', async () => {
    await commit('scripts/Car.cs', 'class Car {}\n', 'add the car');
    pages.put({ ...carPage, body: 'Speed is set in scripts/Car.cs:2.' });
    await commit('scripts/Hud.cs', 'class Hud {}\n', 'add the hud');

    expect(pages.freshness('car-api')?.changed).toEqual([]);
    expect(pages.stalePages()).toEqual([]);
  });

  it('reports the stale page worst first, and clears it once the page is rewritten', async () => {
    await commit('scripts/Car.cs', 'class Car {}\n', 'add the car');
    pages.put({ ...carPage, body: 'Speed is set in scripts/Car.cs:2.' });
    pages.put({
      id: 'hud',
      kind: 'feature',
      title: 'Hud',
      summary: 'What the hud shows.',
      body: 'Labels are built in scripts/Hud.cs.',
    });
    await commit('scripts/Hud.cs', 'class Hud {}\n', 'add the hud');
    await commit('scripts/Car.cs', 'class Car { int speed; }\n', 'add speed');
    await commit('scripts/Car.cs', 'class Car { int speed; int grip; }\n', 'add grip');

    const stale = pages.stalePages();

    expect(stale.map((page) => page.id)).toEqual(['car-api', 'hud']);
    expect(stale[0]?.commits).toBe(2);
    expect(stale[0]?.files).toEqual(['scripts/Car.cs']);
    expect(stale[1]?.commits).toBe(1);

    // Rewriting the page re-anchors it: the report is about pages nobody has looked at since.
    pages.put({ id: 'car-api', body: 'Speed and grip are set in scripts/Car.cs.' });
    expect(pages.stalePages().map((page) => page.id)).toEqual(['hud']);
  });

  it('honours a limit, so a large knowledge base still answers quickly', async () => {
    await commit('scripts/Car.cs', 'class Car {}\n', 'add the car');
    pages.put({ ...carPage, body: 'Speed is set in scripts/Car.cs:2.' });
    pages.put({
      id: 'hud',
      kind: 'feature',
      title: 'Hud',
      summary: 'S',
      body: 'scripts/Car.cs too.',
    });
    await commit('scripts/Car.cs', 'class Car { int speed; }\n', 'add speed');

    expect(pages.stalePages(1)).toHaveLength(1);
  });
});
