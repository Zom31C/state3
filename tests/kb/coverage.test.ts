import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isDocumentableFile } from '../../src/kb/sources.js';
import { PageStore } from '../../src/kb/store.js';
import { renderCoverageReport } from '../../src/mcp/kb-tools.js';
import { TaskStore } from '../../src/tasks/store.js';

/**
 * Coverage against a real repository.
 *
 * The report answers "what would a cold session have to read?", and both halves of that come
 * from git — the file list and the churn ranking — so a fake would only test that the store
 * repeats what it was told.
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

async function commit(file: string, contents: string, message: string): Promise<void> {
  await mkdir(path.dirname(path.join(project, file)), { recursive: true });
  await writeFile(path.join(project, file), contents, 'utf8');
  git('add', file);
  git('-c', 'user.email=test@state3', '-c', 'user.name=test', 'commit', '-q', '-m', message);
}

beforeEach(async () => {
  project = await mkdtemp(path.join(tmpdir(), 'state3-coverage-'));
  git('init', '-q');
  tasks = new TaskStore(path.join(project, '.state3'));
  pages = new PageStore(tasks);
});

afterEach(async () => {
  tasks.close();
  await rm(project, { recursive: true, force: true });
});

describe('isDocumentableFile', () => {
  it('takes a source file and leaves out what a lock tool rewrites wholesale', () => {
    expect(isDocumentableFile('scripts/Car.cs')).toBe(true);
    expect(isDocumentableFile('README.md')).toBe(true);
    expect(isDocumentableFile('package-lock.json')).toBe(false);
    expect(isDocumentableFile('sub/dir/yarn.lock')).toBe(false);
  });

  it('takes a path with a directory in it, which is what a page body can anchor to', () => {
    expect(isDocumentableFile('tools/dev')).toBe(true);
    expect(isDocumentableFile('LICENSE')).toBe(false);
  });

  it('takes a hidden file, whose dot is part of the name and not a missing extension', () => {
    expect(isDocumentableFile('.gitignore')).toBe(true);
    expect(isDocumentableFile('.env')).toBe(true);
    expect(isDocumentableFile('.prettierrc.json')).toBe(true);
    expect(isDocumentableFile('.qwen/settings.json')).toBe(true);
    // A hidden directory is still not a file: git reports what is under it.
    expect(isDocumentableFile('.state3')).toBe(false);
  });
});

describe('PageStore.coverage', () => {
  it('names the files no page mentions, most-changed first', async () => {
    await commit('scripts/Car.cs', 'class Car {}\n', 'add the car');
    await commit('scripts/Hud.cs', 'class Hud {}\n', 'add the hud');
    await commit('scripts/Hud.cs', 'class Hud { int x; }\n', 'hud grows');
    await commit('scripts/RiverWorks.cs', 'class RiverWorks {}\n', 'add the rivers');
    pages.put({
      id: 'car-api',
      kind: 'feature',
      title: 'Car API',
      summary: 'What the controller exposes.',
      body: 'Speed is set in scripts/Car.cs:2.',
    });

    const report = pages.coverage();

    expect(report.tracked).toBe(3);
    expect(report.covered).toBe(1);
    expect(report.pages).toBe(1);
    expect(report.uncovered).toEqual([
      { path: 'scripts/Hud.cs', commits: 2 },
      { path: 'scripts/RiverWorks.cs', commits: 1 },
    ]);
    expect(report.uncoveredTotal).toBe(2);
  });

  it('counts a file an archived page names as covered: it is written down, and search reaches it', async () => {
    await commit('scripts/Car.cs', 'class Car {}\n', 'add the car');
    pages.put({
      id: 'car-api',
      kind: 'feature',
      title: 'Car API',
      summary: 'S',
      status: 'archived',
      body: 'scripts/Car.cs holds the controller.',
    });

    const report = pages.coverage();

    expect(report.covered).toBe(1);
    expect(report.uncoveredTotal).toBe(0);
  });

  it('counts a file a symbol line names as covered, which is the point of the field', async () => {
    await commit('scripts/Car.cs', 'class Car {}\n', 'add the car');
    await commit('scripts/Hud.cs', 'class Hud {}\n', 'add the hud');
    pages.put({
      id: 'car-api',
      kind: 'feature',
      title: 'Car API',
      summary: 'What the controller exposes.',
      // The body never names the file; the symbol line does.
      body: 'The controller takes input and moves the car.',
      symbols: ['Car.ApplyInput — scripts/Car.cs'],
    });

    const report = pages.coverage();

    expect(report.covered).toBe(1);
    expect(report.uncovered.map((file) => file.path)).toEqual(['scripts/Hud.cs']);
  });

  it('says so when the knowledge base covers everything it could', async () => {
    await commit('scripts/Car.cs', 'class Car {}\n', 'add the car');
    pages.put({
      id: 'car-api',
      kind: 'feature',
      title: 'Car API',
      summary: 'S',
      body: 'scripts/Car.cs.',
    });

    const report = pages.coverage();

    expect(report).toMatchObject({ tracked: 1, covered: 1, uncovered: [], uncoveredTotal: 0 });
  });

  it('leaves a lockfile out of the count, so the report is about code a page could describe', async () => {
    await commit('scripts/Car.cs', 'class Car {}\n', 'add the car');
    await commit('package-lock.json', '{}\n', 'lock');

    expect(pages.coverage().tracked).toBe(1);
  });

  it('lists at most the limit, and still says how many there are in all', async () => {
    for (const name of ['a.cs', 'b.cs', 'c.cs']) {
      await commit(`scripts/${name}`, `class ${name} {}\n`, `add ${name}`);
    }

    const report = pages.coverage(2);

    expect(report.uncovered).toHaveLength(2);
    expect(report.uncoveredTotal).toBe(3);
    expect(report.uncovered.map((file) => file.path)).toEqual(['scripts/a.cs', 'scripts/b.cs']);
  });

  it('reports no repository rather than an empty list, which would read as full coverage', async () => {
    // The state root of a project that is not a repository: `git ls-files` has no answer.
    const outside = await mkdtemp(path.join(tmpdir(), 'state3-norepo-'));
    const store = new TaskStore(path.join(outside, '.state3'));
    try {
      const report = new PageStore(store).coverage();
      expect(report.tracked).toBeNull();
      expect(report.uncovered).toEqual([]);
    } finally {
      store.close();
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('renderCoverageReport', () => {
  it('answers a project with no repository to list', () => {
    const text = renderCoverageReport({
      tracked: null,
      covered: 0,
      uncovered: [],
      uncoveredTotal: 0,
      window: 200,
      pages: 0,
    });

    expect(text).toContain('this project has none to ask');
    expect(text).toContain('page {"op":"list"}');
  });

  it('answers full coverage without a list to read', () => {
    const text = renderCoverageReport({
      tracked: 12,
      covered: 12,
      uncovered: [],
      uncoveredTotal: 0,
      window: 200,
      pages: 4,
    });

    expect(text).toContain('every documentable file this repository tracks is named by a page');
    expect(text).toContain('12 of 12 file(s), over 4 page(s)');
  });

  it('puts the count before the list, and the churn each file carries', () => {
    const text = renderCoverageReport({
      tracked: 3,
      covered: 1,
      uncovered: [
        { path: 'scripts/Hud.cs', commits: 2 },
        { path: 'scripts/RiverWorks.cs', commits: 1 },
      ],
      uncoveredTotal: 2,
      window: 200,
      pages: 1,
    });

    expect(text.split('\n')[0]).toContain('1 of 3 documentable file(s) are named by a page');
    expect(text).toContain('- scripts/Hud.cs — 2 commit(s)');
    expect(text).toContain('- scripts/RiverWorks.cs — 1 commit(s)');
    expect(text).toContain('ranked by the last 200 commits');
    expect(text).toContain('op "patch"');
  });
});
