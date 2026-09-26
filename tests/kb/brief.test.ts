import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  FOOTER_RESERVE_CHARS,
  buildBrief,
  briefLine,
  renderProjectBrief,
} from '../../src/kb/brief.js';
import { PageStore } from '../../src/kb/store.js';
import type { PageSummary } from '../../src/kb/schema.js';
import { TaskStore } from '../../src/tasks/store.js';

function page(overrides: Partial<PageSummary> & { id: string }): PageSummary {
  return {
    kind: 'note',
    title: `Title of ${overrides.id}`,
    summary: `summary of ${overrides.id}`,
    status: 'current',
    pin: false,
    parent: null,
    updatedAt: '2026-09-11T10:00:00.000Z',
    ...overrides,
  };
}

const reserved = [
  page({ id: 'project', kind: 'project', summary: 'What this project is.' }),
  page({ id: 'user-intent', kind: 'user-intent', summary: 'What the user wants.' }),
  page({ id: 'onboarding', kind: 'onboarding', summary: 'How to start here.' }),
];

describe('buildBrief', () => {
  it('tells a project with no pages which three to write first', () => {
    const brief = buildBrief([]);

    expect(brief).toContain('no knowledge base yet');
    expect(brief).toContain('project, user-intent, onboarding');
  });

  it('opens with the reserved pages, and shows their summary rather than their title', () => {
    const brief = buildBrief([page({ id: 'auth', kind: 'feature' }), ...reserved]);

    const lines = brief.split('\n');
    expect(lines[0]).toBe('# Project brief');
    expect(brief).toContain('Start here:');
    expect(brief).toContain('- project: What this project is.');
    expect(brief).toContain('- user-intent: What the user wants.');
    expect(brief).toContain('- onboarding: How to start here.');
    // Reserved pages come before the ordinary ones, whatever order they were given in.
    expect(brief.indexOf('- project:')).toBeLessThan(brief.indexOf('- auth'));
  });

  it('groups the rest by kind, newest first inside a group', () => {
    const brief = buildBrief([
      page({ id: 'older', kind: 'feature', updatedAt: '2026-09-01T10:00:00.000Z' }),
      page({ id: 'newer', kind: 'feature', updatedAt: '2026-09-09T10:00:00.000Z' }),
      page({ id: 'why-sqlite', kind: 'decision' }),
    ]);

    expect(brief).toContain('Features:');
    expect(brief).toContain('Decisions:');
    expect(brief.indexOf('- newer')).toBeLessThan(brief.indexOf('- older'));
    expect(brief.indexOf('Features:')).toBeLessThan(brief.indexOf('Decisions:'));
  });

  it('gives pinned pages their own section ahead of the kind sections', () => {
    const brief = buildBrief([
      page({ id: 'plain', kind: 'feature' }),
      page({ id: 'pinned-note', kind: 'note', pin: true }),
    ]);

    expect(brief).toContain('Pinned:');
    expect(brief.indexOf('Pinned:')).toBeLessThan(brief.indexOf('Features:'));
    expect(brief).toContain('- pinned-note *');
  });

  it('marks a stale page and leaves an archived one out, saying how many', () => {
    const brief = buildBrief([
      page({ id: 'dodgy', kind: 'feature', status: 'stale' }),
      page({ id: 'gone', kind: 'note', status: 'archived' }),
    ]);

    expect(brief).toContain('- dodgy (stale):');
    expect(brief).not.toContain('gone');
    expect(brief).toContain('1 archived page(s) left out');
  });

  it('names the two calls that go deeper, so a reader is never stuck at level zero', () => {
    const brief = buildBrief(reserved);

    expect(brief).toContain('page {"op":"get","id":"<id>"}');
    expect(brief).toContain('search {"query":"…"');
  });

  it('stays inside the budget by dropping whole lines, and says what it dropped', () => {
    const many = [
      ...reserved,
      ...Array.from({ length: 12 }, (_, index) =>
        page({ id: `feat-${index}`, kind: 'feature', summary: `what feature ${index} does` }),
      ),
    ];

    const brief = buildBrief(many, { budgetChars: 900 });

    expect(brief.length).toBeLessThanOrEqual(900);
    expect(brief).toContain('- project: What this project is.');
    expect(brief).toContain('more page(s) did not fit this brief');
    expect(brief).toContain('page {"op":"list"}');
    // Nothing is cut in half: every page line in the brief is a complete line.
    for (const line of brief.split('\n')) {
      if (!line.startsWith('- feat-')) continue;
      const id = line.slice(2).split(/[ *(:]/)[0] ?? '';
      const source = many.find((candidate) => candidate.id === id);
      expect(source, `line for ${id}`).toBeDefined();
      expect(line).toBe(briefLine(source as PageSummary));
    }
  });

  it('keeps the reserved pages even when the budget barely fits them', () => {
    // Measured, not hard-coded: the header grows as the brief learns to say more, and a
    // fixed number here would quietly turn this into a test that nothing fits at all. The
    // budget accounts for the footer reserve, which the rendered text does not contain.
    const justEnough = buildBrief(reserved).length + FOOTER_RESERVE_CHARS;

    const brief = buildBrief([...reserved, page({ id: 'extra', kind: 'note' })], {
      budgetChars: justEnough,
    });

    expect(brief).toContain('- project: What this project is.');
    expect(brief).not.toContain('- extra');
  });
});

describe('renderProjectBrief over a real database', () => {
  let dir: string;
  let tasks: TaskStore;
  let pages: PageStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'state3-brief-'));
    tasks = new TaskStore(dir);
    pages = new PageStore(tasks);
  });

  afterEach(async () => {
    tasks.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('costs the same whether a page body is empty or twenty thousand characters', () => {
    // The point of the brief: its size grows with the NUMBER of pages, never with their size.
    pages.put({ id: 'project', kind: 'project', title: 'P', summary: 'One line.' });
    const small = renderProjectBrief(pages);

    pages.put({ id: 'project', body: 'x'.repeat(20_000) });
    const large = renderProjectBrief(pages);

    expect(large).toBe(small);
    expect(large).toContain('- project: One line.');
    expect(large).not.toContain('xxx');
  });

  it('reads what the page tool wrote, with no bodies', () => {
    pages.put({ id: 'project', kind: 'project', title: 'state3', summary: 'Task state.' });
    pages.put({
      id: 'auth',
      kind: 'feature',
      title: 'Authentication',
      summary: 'Who is asking.',
      body: 'A body that must not appear in the brief.',
    });

    const brief = renderProjectBrief(pages);

    expect(brief).toContain('- project: Task state.');
    expect(brief).toContain('- auth: Authentication — Who is asking.');
    expect(brief).not.toContain('must not appear');
  });

  it('briefs an empty project without touching the disk', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'state3-brief-empty-'));
    const owner = new TaskStore(empty);
    try {
      expect(renderProjectBrief(new PageStore(owner))).toContain('no knowledge base yet');
    } finally {
      owner.close();
      await rm(empty, { recursive: true, force: true });
    }
  });
});
