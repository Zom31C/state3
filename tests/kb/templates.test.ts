import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildBrief } from '../../src/kb/brief.js';
import {
  BODY_MAX_CHARS,
  SINGLETON_PAGE_KINDS,
  SUMMARY_MAX_CHARS,
  pageInputSchema,
} from '../../src/kb/schema.js';
import { PageStore } from '../../src/kb/store.js';
import {
  PAGE_TEMPLATES,
  initPages,
  renderInitReport,
  templatePage,
} from '../../src/kb/templates.js';
import { TaskStore } from '../../src/tasks/store.js';

let dir: string;
let tasks: TaskStore;
let pages: PageStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'state3-templates-'));
  tasks = new TaskStore(dir);
  pages = new PageStore(tasks);
});

afterEach(async () => {
  tasks.close();
  await rm(dir, { recursive: true, force: true });
});

describe('the reserved-page templates', () => {
  it('covers exactly the singleton kinds, each stored under its kind as its id', () => {
    expect(Object.keys(PAGE_TEMPLATES).sort()).toEqual([...SINGLETON_PAGE_KINDS].sort());
    for (const kind of SINGLETON_PAGE_KINDS) {
      expect(templatePage(kind)).toMatchObject({ id: kind, kind, status: 'stale' });
    }
  });

  it('is acceptable to the store: schema-valid, and inside the summary and body limits', () => {
    for (const kind of SINGLETON_PAGE_KINDS) {
      const template = PAGE_TEMPLATES[kind];
      expect(pageInputSchema.safeParse(templatePage(kind)).success, kind).toBe(true);
      expect(template.summary.length, `${kind} summary`).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
      expect(template.body.length, `${kind} body`).toBeLessThanOrEqual(BODY_MAX_CHARS);
      expect(template.body.length, `${kind} body is worth storing`).toBeGreaterThan(200);
    }
  });

  it('says it is a template in the summary, which is all the brief shows', () => {
    for (const kind of SINGLETON_PAGE_KINDS) {
      expect(PAGE_TEMPLATES[kind].summary, kind).toContain('TEMPLATE');
      expect(PAGE_TEMPLATES[kind].body, kind).toContain('TEMPLATE');
      expect(PAGE_TEMPLATES[kind].body, kind).toContain('"status":"current"');
    }
  });

  it('asks for the same thing everywhere: fill in the headings, then mark the page current', () => {
    for (const kind of SINGLETON_PAGE_KINDS) {
      expect(PAGE_TEMPLATES[kind].body, kind).toContain('<');
    }
  });

  it('makes onboarding the guide for an agent with no context, cheapest read first', () => {
    const body = PAGE_TEMPLATES.onboarding.body;

    // The reading order, and the two habits that keep a project documented: Σ patched as work
    // progresses, and checks recorded with their real results rather than claimed.
    expect(body.indexOf('project_brief')).toBeLessThan(body.indexOf('task_show'));
    expect(body.indexOf('task_show')).toBeLessThan(body.indexOf('search'));
    expect(body).toContain('page {"op":"get","id":"project"}');
    expect(body).toContain('task_patch');
    expect(body).toContain('verifications');
    expect(body).toContain('task_finish');
  });

  it('keeps project and user-intent about the project and the user, not about this tool', () => {
    expect(PAGE_TEMPLATES.project.body).toContain('## Commands');
    expect(PAGE_TEMPLATES.project.body).toContain('## Layout');
    expect(PAGE_TEMPLATES['user-intent'].body).toContain('## Out of scope');
    expect(PAGE_TEMPLATES['user-intent'].body).toContain('## Priorities');
  });
});

describe('initPages', () => {
  it('scaffolds the three reserved pages in a project that has none', () => {
    const report = initPages(pages);

    expect(report).toEqual({
      created: ['project', 'user-intent', 'onboarding'],
      existing: [],
    });
    expect(pages.count()).toBe(3);
    for (const kind of SINGLETON_PAGE_KINDS) {
      expect(pages.get(kind)?.kind).toBe(kind);
      // Stale until filled in: the brief prints the status, so a template cannot pass as truth.
      expect(pages.get(kind)?.status).toBe('stale');
      expect(pages.get(kind)?.body).toContain('TEMPLATE');
    }
  });

  it('leaves a page that exists exactly as it was, however far it got', () => {
    pages.put({
      id: 'project',
      kind: 'project',
      title: 'state3',
      summary: 'External validated task state.',
      body: 'The real description.',
      status: 'current',
    });
    const before = pages.get('project');

    const report = initPages(pages);

    expect(report).toEqual({ created: ['user-intent', 'onboarding'], existing: ['project'] });
    expect(pages.get('project')).toEqual(before);
  });

  it('writes nothing at all on a second call', () => {
    initPages(pages);
    const before = pages.list();

    const report = initPages(pages);

    expect(report.created).toEqual([]);
    expect(report.existing).toEqual(['project', 'user-intent', 'onboarding']);
    expect(pages.list()).toEqual(before);
  });

  it('puts the scaffolded pages in the brief, marked stale and carrying no body', () => {
    initPages(pages);

    const brief = buildBrief(pages.list());

    expect(brief).toContain('- project (stale): TEMPLATE');
    expect(brief).toContain('- onboarding (stale): TEMPLATE');
    expect(brief).not.toContain('replace every');
    expect(brief.length).toBeLessThan(1200);
  });

  it('creates a knowledge base in a root that had nothing but an empty directory', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'state3-templates-empty-'));
    const owner = new TaskStore(empty);
    try {
      expect(initPages(new PageStore(owner)).created).toHaveLength(3);
    } finally {
      owner.close();
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe('renderInitReport', () => {
  it('names what appeared and the call that fills it in', () => {
    const text = renderInitReport(initPages(pages));

    expect(text).toContain('Scaffolded 3 template page(s): project, user-intent, onboarding.');
    expect(text).toContain('(stale)');
    expect(text).toContain('page {"op":"get","id":"project"}');
    expect(text).toContain('"status":"current"');
  });

  it('says plainly that nothing was overwritten when every page existed', () => {
    initPages(pages);

    const text = renderInitReport(initPages(pages));

    expect(text).toContain('Nothing to scaffold: project, user-intent, onboarding already exist.');
    expect(text).toContain('never overwrites');
  });

  it('names both halves when some pages were already there', () => {
    pages.put({ id: 'user-intent', kind: 'user-intent', title: 'Wants', summary: 'The real one.' });

    const text = renderInitReport(initPages(pages));

    expect(text).toContain('Scaffolded 2 template page(s): project, onboarding.');
    expect(text).toContain('Left as they were: user-intent.');
  });
});
