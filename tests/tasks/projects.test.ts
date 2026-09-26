import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProjectEntry, TaskStorePort } from '../../src/tasks/ports.js';
import {
  createProjectResolver,
  describeProjects,
  parseProjectsSpec,
  PROJECT_NAME,
  singleStoreResolver,
  UnknownProjectError,
} from '../../src/tasks/projects.js';
import { TaskStore } from '../../src/tasks/store.js';

const cwd = resolve('/fake/host-startup');

/** A store per root: the resolver only ever hands these out, it never touches the disk. */
const storeAt = (rootDir: string): TaskStorePort => new TaskStore(rootDir);

describe('PROJECT_NAME', () => {
  it('accepts short lowercase names starting with a letter or a digit', () => {
    for (const name of [
      'worker',
      'w',
      'a1',
      'my-project',
      'my_project',
      '9lives',
      'a'.repeat(64),
    ]) {
      expect(PROJECT_NAME.test(name)).toBe(true);
    }
  });

  it('rejects names a model could not type safely', () => {
    for (const name of [
      'Worker',
      '-lead',
      '_lead',
      'has space',
      'has/slash',
      'has.dot',
      'has=sign',
      '',
      'a'.repeat(65),
    ]) {
      expect(PROJECT_NAME.test(name)).toBe(false);
    }
  });
});

describe('parseProjectsSpec', () => {
  it('returns no entries for an empty or blank spec', () => {
    expect(parseProjectsSpec('', cwd)).toEqual([]);
    expect(parseProjectsSpec('   ', cwd)).toEqual([]);
    expect(parseProjectsSpec('\n', cwd)).toEqual([]);
  });

  it('parses one name=dir declaration', () => {
    expect(parseProjectsSpec('worker=state/worker', cwd)).toEqual([
      { name: 'worker', rootDir: resolve(cwd, 'state/worker') },
    ]);
  });

  it('parses semicolon-separated declarations in order', () => {
    expect(parseProjectsSpec('worker=state/worker;review=state/review', cwd)).toEqual([
      { name: 'worker', rootDir: resolve(cwd, 'state/worker') },
      { name: 'review', rootDir: resolve(cwd, 'state/review') },
    ]);
  });

  it('parses newline-separated declarations and ignores blank lines', () => {
    expect(parseProjectsSpec('worker=state/worker\n\nreview=state/review\n', cwd)).toEqual([
      { name: 'worker', rootDir: resolve(cwd, 'state/worker') },
      { name: 'review', rootDir: resolve(cwd, 'state/review') },
    ]);
  });

  it('parses the JSON object form', () => {
    const spec = JSON.stringify({ worker: 'state/worker', review: resolve(cwd, 'state/review') });
    expect(parseProjectsSpec(spec, cwd)).toEqual([
      { name: 'worker', rootDir: resolve(cwd, 'state/worker') },
      { name: 'review', rootDir: resolve(cwd, 'state/review') },
    ]);
  });

  it('resolves relative directories against the cwd it is given', () => {
    expect(parseProjectsSpec('worker=state/worker', cwd)[0]?.rootDir).toBe(
      resolve(cwd, 'state/worker'),
    );
    expect(parseProjectsSpec('worker=./w', cwd)[0]?.rootDir).toBe(resolve(cwd, 'w'));
  });

  it('keeps an absolute directory as it is', () => {
    const absolute = resolve(cwd, 'elsewhere/state');
    expect(parseProjectsSpec(`worker=${absolute}`, cwd)).toEqual([
      { name: 'worker', rootDir: absolute },
    ]);
  });

  it('defaults the cwd to the process working directory', () => {
    expect(parseProjectsSpec('worker=state/worker')).toEqual([
      { name: 'worker', rootDir: resolve(process.cwd(), 'state/worker') },
    ]);
  });

  it('trims whitespace around the name and the directory', () => {
    expect(parseProjectsSpec('  worker  =  state/worker  ', cwd)).toEqual([
      { name: 'worker', rootDir: resolve(cwd, 'state/worker') },
    ]);
  });

  it('rejects an invalid project name', () => {
    expect(() => parseProjectsSpec('Worker=state/worker', cwd)).toThrow(
      /invalid project name "Worker"/,
    );
    expect(() => parseProjectsSpec('has space=state/worker', cwd)).toThrow(
      /invalid project name "has space"/,
    );
    expect(() => parseProjectsSpec('-lead=state/worker', cwd)).toThrow(/invalid project name/);
  });

  it('rejects an empty directory', () => {
    expect(() => parseProjectsSpec('worker=', cwd)).toThrow(
      /project "worker" has an empty directory/,
    );
    expect(() => parseProjectsSpec('worker=   ', cwd)).toThrow(/empty directory/);
  });

  it('rejects a declaration without a separator', () => {
    expect(() => parseProjectsSpec('worker', cwd)).toThrow(
      /project declaration "worker" must look like name=directory/,
    );
    expect(() => parseProjectsSpec('=state/worker', cwd)).toThrow(/must look like name=directory/);
    expect(() => parseProjectsSpec('worker=state/a;review', cwd)).toThrow(
      /project declaration "review" must look like name=directory/,
    );
  });

  it('rejects a name declared twice', () => {
    expect(() => parseProjectsSpec('worker=state/a;worker=state/b', cwd)).toThrow(
      /project "worker" is declared twice/,
    );
    expect(() => parseProjectsSpec('  worker =state/a;worker= state/b', cwd)).toThrow(
      /project "worker" is declared twice/,
    );
  });

  it('rejects JSON that does not parse or is not an object of strings', () => {
    expect(() => parseProjectsSpec('{oops', cwd)).toThrow(
      /STATE3_PROJECTS looks like JSON but does not parse/,
    );
    expect(() => parseProjectsSpec('{"worker": 3}', cwd)).toThrow(
      /project "worker" must map to a directory string/,
    );
    expect(() => parseProjectsSpec('{"worker": {}}', cwd)).toThrow(
      /must map to a directory string/,
    );
  });

  it('keeps a directory containing an equals sign intact', () => {
    expect(parseProjectsSpec('worker=state/a=b', cwd)).toEqual([
      { name: 'worker', rootDir: resolve(cwd, 'state/a=b') },
    ]);
  });
});

describe('describeProjects', () => {
  it('says so when nothing is declared', () => {
    expect(describeProjects([])).toBe('none declared');
  });

  it('renders name and root for every entry', () => {
    const entries: ProjectEntry[] = [
      { name: 'worker', rootDir: resolve(cwd, 'state/worker') },
      { name: 'review', rootDir: resolve(cwd, 'state/review') },
    ];
    expect(describeProjects(entries)).toBe(
      `worker (${resolve(cwd, 'state/worker')}), review (${resolve(cwd, 'state/review')})`,
    );
  });
});

describe('createProjectResolver', () => {
  const entries: ProjectEntry[] = [
    { name: 'worker', rootDir: resolve(cwd, 'state/worker') },
    { name: 'review', rootDir: resolve(cwd, 'state/review') },
  ];

  function makeResolver() {
    const primary = storeAt(resolve(cwd, 'state/primary'));
    const opened: string[] = [];
    const resolver = createProjectResolver(primary, entries, (rootDir) => {
      opened.push(rootDir);
      return storeAt(rootDir);
    });
    return { primary, opened, resolver };
  }

  it('returns the primary store when no project is named', () => {
    const { primary, opened, resolver } = makeResolver();
    expect(resolver.resolve()).toBe(primary);
    expect(resolver.resolve('')).toBe(primary);
    expect(resolver.resolve('   ')).toBe(primary);
    expect(opened).toEqual([]);
  });

  it('opens the declared root of the named project', () => {
    const { primary, opened, resolver } = makeResolver();
    const worker = resolver.resolve('worker');
    expect(worker).not.toBe(primary);
    expect(worker.rootDir).toBe(resolve(cwd, 'state/worker'));
    expect(opened).toEqual([resolve(cwd, 'state/worker')]);

    expect(resolver.resolve('review').rootDir).toBe(resolve(cwd, 'state/review'));
    expect(opened).toHaveLength(2);
  });

  it('caches: a second resolve returns the same store instance', () => {
    const { opened, resolver } = makeResolver();
    const first = resolver.resolve('worker');
    const second = resolver.resolve('worker');
    expect(second).toBe(first);
    expect(opened).toEqual([resolve(cwd, 'state/worker')]);
  });

  it('trims the project name before looking it up', () => {
    const { resolver } = makeResolver();
    expect(resolver.resolve('  worker  ').rootDir).toBe(resolve(cwd, 'state/worker'));
  });

  it('throws UnknownProjectError for a name that is not declared, listing the declared ones', () => {
    const { opened, resolver } = makeResolver();
    let thrown: unknown = null;
    try {
      resolver.resolve('nope');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnknownProjectError);
    expect((thrown as UnknownProjectError).name).toBe('UnknownProjectError');
    expect((thrown as UnknownProjectError).message).toContain('unknown project "nope"');
    expect((thrown as UnknownProjectError).message).toContain(describeProjects(entries));
    expect(opened).toEqual([]);
  });

  it('is case-sensitive about declared names', () => {
    const { resolver } = makeResolver();
    expect(() => resolver.resolve('Worker')).toThrow(/unknown project "Worker"/);
  });

  it('exposes the declared projects', () => {
    const { resolver } = makeResolver();
    expect(resolver.projects()).toBe(entries);
    expect(resolver.projects().map((entry) => entry.name)).toEqual(['worker', 'review']);
  });

  it('resolves nothing but the primary store when no project is declared', () => {
    const primary = storeAt(resolve(cwd, 'state/primary'));
    const resolver = createProjectResolver(primary, [], () => primary);
    expect(resolver.resolve()).toBe(primary);
    expect(resolver.projects()).toEqual([]);
    expect(() => resolver.resolve('worker')).toThrow(/declared projects: none declared/);
  });
});

describe('singleStoreResolver', () => {
  it('lands every call on the one store', () => {
    const store = storeAt(resolve(cwd, 'state/only'));
    const resolver = singleStoreResolver(store);
    expect(resolver.resolve()).toBe(store);
    expect(resolver.resolve('')).toBe(store);
    expect(resolver.resolve('   ')).toBe(store);
    expect(resolver.projects()).toEqual([]);
  });

  it('still refuses a named project, because none is declared', () => {
    const resolver = singleStoreResolver(storeAt(resolve(cwd, 'state/only')));
    expect(() => resolver.resolve('worker')).toThrow(UnknownProjectError);
    expect(() => resolver.resolve('worker')).toThrow(/unknown project "worker"/);
    expect(() => resolver.resolve('worker')).toThrow(/declared projects: none declared/);
  });
});
