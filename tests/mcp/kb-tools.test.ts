import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { KbResolver } from '../../src/kb/ports.js';
import { LinkStore } from '../../src/kb/links.js';
import { BODY_MAX_CHARS, SUMMARY_MAX_CHARS } from '../../src/kb/schema.js';
import { PageStore } from '../../src/kb/store.js';
import { createKbTools } from '../../src/mcp/kb-tools.js';
import type { TaskToolDefinition, ToolResult } from '../../src/mcp/tools.js';
import { TaskStore } from '../../src/tasks/store.js';

let dir: string;
let tasks: TaskStore;
let pages: PageStore;
let links: LinkStore;
let tools: TaskToolDefinition[];
let byName: Map<string, TaskToolDefinition>;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'skillstate-kbtools-'));
  tasks = new TaskStore(dir);
  pages = new PageStore(tasks);
  links = new LinkStore(tasks);
  const kb: KbResolver = {
    kb: (project?: string) => {
      // The declared-project rule is the resolver's, not the tools'; a test stands in for it.
      if (project !== undefined) throw new Error(`unknown project "${project}" — none declared`);
      return { pages, links };
    },
  };
  tools = createKbTools(kb);
  byName = new Map(tools.map((tool) => [tool.name, tool]));
});

afterEach(async () => {
  tasks.close();
  await rm(dir, { recursive: true, force: true });
});

function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const tool = byName.get(name);
  if (tool === undefined) throw new Error(`no tool "${name}"`);
  return tool.handler(args);
}

const projectPage = {
  op: 'put',
  id: 'project',
  kind: 'project',
  title: 'skillState',
  summary: 'External validated task state for long agent work.',
};

describe('the tool surface', () => {
  it('declares exactly three tools, so the declaration list stays cheap', () => {
    expect(tools.map((tool) => tool.name)).toEqual(['project_brief', 'page', 'search']);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it('documents every op in the page schema, since one tool carries them all', () => {
    const properties = (byName.get('page')?.inputSchema.properties ?? {}) as Record<
      string,
      { enum?: string[] }
    >;
    expect(properties.op?.enum).toEqual([
      'get',
      'put',
      'patch',
      'append',
      'history',
      'stale',
      'coverage',
      'list',
      'delete',
      'init',
      'link',
      'unlink',
      'links',
    ]);
  });

  it('says in the op description what each one is for, since the enum alone cannot', () => {
    const description = String(
      (
        (byName.get('page')?.inputSchema.properties ?? {}) as Record<
          string,
          { description?: string }
        >
      ).op?.description,
    );
    for (const op of ['stale', 'coverage', 'history', 'links']) {
      expect(description).toContain(`${op}:`);
    }
  });

  it('briefs the project through the tool, without any page body', async () => {
    await call('page', { ...projectPage, body: 'A body that must not be briefed.' });

    const brief = await call('project_brief', {});

    expect(brief.ok).toBe(true);
    expect(brief.content).toContain('# Project brief');
    expect(brief.content).toContain(`- project: ${projectPage.summary}`);
    expect(brief.content).not.toContain('must not be briefed');
  });

  it('takes no argument but project, and says so', async () => {
    const refused = await call('project_brief', { budget: 10 });

    expect(refused.ok).toBe(false);
    expect(refused.content).toContain('project_brief does not take "budget"');
  });
});

describe('page put and get', () => {
  it('stores a page and says whether it created or updated it', async () => {
    const created = await call('page', projectPage);
    expect(created.ok).toBe(true);
    expect(created.content).toContain('Stored page project [project] (current)');

    const updated = await call('page', { op: 'put', id: 'project', summary: 'A shorter line.' });
    expect(updated.content).toContain('Updated page project');
    expect(updated.content).toContain('A shorter line.');
    expect(pages.get('project')?.title).toBe('skillState');
  });

  it('reads a page back with its body and its links', async () => {
    await call('page', { ...projectPage, body: 'The runtime lives in src/.' });
    const task = await tasks.start('Build the brief');
    await call('page', {
      op: 'link',
      from: 'page:project',
      rel: 'documents',
      to: `task:${task.meta.id}`,
    });

    const got = await call('page', { op: 'get', id: 'project' });

    expect(got.content).toContain('page project [project] (current)');
    expect(got.content).toContain('The runtime lives in src/.');
    expect(got.content).toContain(`-[documents]-> task:${task.meta.id}`);
  });

  it('accepts a symbol list on put and shows it on get', async () => {
    // Through the tool, not the store: `put` takes only the arguments it declares, so a field
    // missing from that list is refused here and nowhere else.
    const stored = await call('page', {
      ...projectPage,
      symbols: ['TokenVerifier — src/auth/verify.ts'],
    });

    expect(stored.ok).toBe(true);

    const got = await call('page', { op: 'get', id: 'project' });
    expect(got.content).toContain('symbols:');
    expect(got.content).toContain('  TokenVerifier — src/auth/verify.ts');
  });

  it('reports a missing page as an error with a way forward, not as an empty answer', async () => {
    const got = await call('page', { op: 'get', id: 'nope' });

    expect(got.ok).toBe(false);
    expect(got.isError).toBe(true);
    expect(got.content).toContain('No page "nope"');
    // `page get project` is the first call a cold agent makes, so an empty project is pointed at
    // the scaffolding rather than at a listing of nothing.
    expect(got.content).toContain('op "init"');

    await call('page', projectPage);
    expect((await call('page', { op: 'get', id: 'nope' })).content).toContain('op "list"');
  });

  it('refuses a singleton kind under another id, with the category and a hint', async () => {
    const refused = await call('page', {
      op: 'put',
      id: 'overview',
      kind: 'project',
      title: 'Overview',
      summary: 'What this is.',
    });

    expect(refused.ok).toBe(false);
    expect(refused.content).toContain('Refused (guard)');
    expect(refused.content).toContain('its page id must be "project"');
    expect(refused.content).toContain('Nothing was written.');
    expect(refused.content).toContain('Hint:');
    expect(pages.count()).toBe(0);
  });

  it('refuses an argument the chosen op does not take, instead of ignoring it', async () => {
    const refused = await call('page', { op: 'get', id: 'project', body: 'ignored?' });

    expect(refused.ok).toBe(false);
    expect(refused.content).toContain('op "get" does not take "body"');
  });

  it('refuses a bad value with the shared rejection vocabulary', async () => {
    expect((await call('page', { op: 'put', id: 'p', pin: 'yes' })).content).toContain(
      'Refused (type-coercion)',
    );
    // An enum violation is a schema failure, the same category a task patch reports it under.
    expect(
      (await call('page', { op: 'put', id: 'p', kind: 'wiki', title: 'T', summary: 'S' })).content,
    ).toContain('Refused (schema)');
    expect((await call('page', { op: 'put', id: 'p', title: 'T' })).content).toContain(
      'a new page needs',
    );
  });

  it('refuses an op it does not have, and a missing op', async () => {
    expect((await call('page', { op: 'fetch', id: 'p' })).content).toContain('op must be one of');
    expect((await call('page', {})).content).toContain('missing required argument: op');
  });
});

describe('page patch and append', () => {
  const combatBody = [
    '# Car combat',
    '',
    'Status: the code is not written yet.',
    '',
    '## Damage',
    '',
    'Damage is applied in scripts/Car.cs.',
    '',
    '## What is left',
    '',
    '- armour',
    '- ammo',
    '',
  ].join('\n');

  beforeEach(async () => {
    await call('page', {
      op: 'put',
      id: 'car-combat',
      kind: 'feature',
      title: 'Car combat',
      summary: 'How a car takes and deals damage.',
      body: combatBody,
    });
  });

  it('changes two lines of a long body without resending it', async () => {
    const patched = await call('page', {
      op: 'patch',
      id: 'car-combat',
      edits: [
        { find: 'the code is not written yet.', replace: 'step 1 is implemented.' },
        { find: '- armour', replace: '- armour (done)' },
      ],
    });

    expect(patched.ok).toBe(true);
    expect(patched.content).toContain('Patched page car-combat (2 edits)');
    expect(patched.content).toContain(`body ${combatBody.length} -> `);

    const body = pages.get('car-combat')?.body ?? '';
    expect(body).toContain('step 1 is implemented.');
    expect(body).toContain('- armour (done)');
    // The point of the op: everything the edits did not name survives.
    expect(body).toContain('Damage is applied in scripts/Car.cs.');
    expect(body).toContain('- ammo');
    expect(body.length).toBeGreaterThan(combatBody.length);
  });

  it('replaces a section between headings, and appends below an anchor', async () => {
    await call('page', {
      op: 'patch',
      id: 'car-combat',
      edits: [{ section: 'Damage', body: 'Damage is applied in scripts/CarCombat.cs.' }],
    });
    const appended = await call('page', {
      op: 'patch',
      id: 'car-combat',
      edits: [{ after: '## What is left', insert: '- hull repair' }],
    });

    expect(appended.ok).toBe(true);
    const body = pages.get('car-combat')?.body ?? '';
    expect(body).toContain('scripts/CarCombat.cs.');
    expect(body).not.toContain('scripts/Car.cs.');
    expect(body).toContain('## What is left\n- hull repair\n');
  });

  it('refuses an edit that does not match, numbering it and leaving the body alone', async () => {
    const refused = await call('page', {
      op: 'patch',
      id: 'car-combat',
      edits: [
        { find: '- armour', replace: '- armour (done)' },
        { find: '- weapons', replace: '- weapons (done)' },
      ],
    });

    expect(refused.ok).toBe(false);
    expect(refused.content).toContain('Refused (path): edit 2 of 2 refused');
    expect(refused.content).toContain('matches nothing');
    expect(refused.content).toContain('Nothing was written.');
    expect(pages.get('car-combat')?.body).toBe(combatBody);
  });

  it('refuses a body edit for a page that is not there, instead of creating it', async () => {
    const refused = await call('page', {
      op: 'patch',
      id: 'nope',
      edits: [{ find: 'a', replace: 'b' }],
    });

    expect(refused.ok).toBe(false);
    expect(refused.content).toContain('No page "nope" to patch');
    expect(pages.get('nope')).toBeNull();
  });

  it('refuses a malformed edit list, and a missing one', async () => {
    expect((await call('page', { op: 'patch', id: 'car-combat' })).content).toContain(
      'missing required argument: edits',
    );
    expect((await call('page', { op: 'patch', id: 'car-combat', edits: [] })).content).toContain(
      'at least one edit',
    );
    const refused = await call('page', {
      op: 'patch',
      id: 'car-combat',
      edits: [{ find: '- armour' }],
    });
    expect(refused.content).toContain('edit 1');
    expect(pages.get('car-combat')?.body).toBe(combatBody);
  });

  it('takes no whole body with a patch, which is what keeps the two ops apart', async () => {
    const refused = await call('page', {
      op: 'patch',
      id: 'car-combat',
      edits: [{ find: '- armour', replace: '- armour (done)' }],
      body: 'rewritten',
    });

    expect(refused.ok).toBe(false);
    expect(refused.content).toContain('op "patch" does not take "body"');
  });

  it('re-indexes a patched body for search, like any other write', async () => {
    await call('page', {
      op: 'patch',
      id: 'car-combat',
      edits: [{ find: '- armour', replace: '- integritas' }],
    });

    const hits = await call('search', { query: 'integritas' });
    expect(hits.ok).toBe(true);
    expect(hits.content).toContain('page:car-combat');
  });

  it('refuses a patch that would grow the body past its limit', async () => {
    await call('page', { op: 'put', id: 'big', kind: 'note', title: 'B', summary: 'S', body: 'x' });
    const refused = await call('page', {
      op: 'patch',
      id: 'big',
      edits: [{ find: 'x', replace: `x${'y'.repeat(BODY_MAX_CHARS)}` }],
    });

    expect(refused.ok).toBe(false);
    expect(refused.content).toContain('Refused (schema)');
    expect(pages.get('big')?.body).toBe('x');
  });

  it('appends to the end of a body, one blank line below what was there', async () => {
    const addition = '## Measurement of 2026-09-18\n\n60 fps at 1080p.';
    const appended = await call('page', { op: 'append', id: 'car-combat', body: addition });

    expect(appended.ok).toBe(true);
    expect(appended.content).toContain(`Appended ${addition.length} chars to page car-combat`);
    const body = pages.get('car-combat')?.body ?? '';
    expect(body.startsWith(combatBody.trimEnd())).toBe(true);
    expect(body).toContain('- ammo\n\n## Measurement of 2026-09-18');
    expect((await call('page', { op: 'append', id: 'nope', body: 'x' })).content).toContain(
      'No page "nope" to append',
    );
  });
});

describe('page history', () => {
  beforeEach(async () => {
    await call('page', { ...projectPage, body: 'the first body' });
    await call('page', { op: 'put', id: 'project', body: 'the second body' });
  });

  it('lists the previous bodies with their size, and says how to read one', async () => {
    const listed = await call('page', { op: 'history', id: 'project' });

    expect(listed.ok).toBe(true);
    expect(listed.content).toContain('Previous bodies of page project (1, newest first');
    expect(listed.content).toContain('— 14 chars');
    expect(listed.content).not.toContain('the first body');
    expect(listed.content).toContain('"op":"history","id":"project","revision":');
  });

  it('prints one stored body in full, addressed by the seq the listing showed', async () => {
    const listed = await call('page', { op: 'history', id: 'project' });
    const seq = Number(/#(\d+)/.exec(listed.content)?.[1] ?? '');

    const one = await call('page', { op: 'history', id: 'project', revision: seq });

    expect(one.ok).toBe(true);
    expect(one.content).toContain(`(#${seq}, 14 chars)`);
    expect(one.content).toContain('the first body');
  });

  it('refuses a version the page does not have, and points at the listing', async () => {
    const refused = await call('page', { op: 'history', id: 'project', revision: 999999 });

    expect(refused.ok).toBe(false);
    expect(refused.content).toContain('no body version #999999');
    expect(refused.content).toContain('"op":"history","id":"project"');
  });

  it('says when a page has never been rewritten, instead of listing nothing', async () => {
    await call('page', {
      op: 'put',
      id: 'fresh',
      kind: 'note',
      title: 'F',
      summary: 'S',
      body: 'written once',
    });

    const listed = await call('page', { op: 'history', id: 'fresh' });

    expect(listed.ok).toBe(true);
    expect(listed.content).toContain('has no previous body');
  });

  it('refuses a page that is not there', async () => {
    expect((await call('page', { op: 'history', id: 'nope' })).content).toContain('No page "nope"');
  });
});

describe('a refused size, reported with the number that crossed it', () => {
  it('says how long the summary was and what the limit is', async () => {
    const summary = 'x'.repeat(SUMMARY_MAX_CHARS + 14);
    const refused = await call('page', {
      op: 'put',
      id: 'car-api-surface',
      kind: 'feature',
      title: 'Car API',
      summary,
    });

    expect(refused.ok).toBe(false);
    expect(refused.content).toContain('Refused (schema)');
    expect(refused.content).toContain(
      `"summary" is ${SUMMARY_MAX_CHARS + 14} chars, limit ${SUMMARY_MAX_CHARS}`,
    );
    expect(pages.count()).toBe(0);
  });

  it('says the same for a body a patch would grow past its limit', async () => {
    await call('page', { op: 'put', id: 'big', kind: 'note', title: 'B', summary: 'S', body: 'x' });
    const refused = await call('page', {
      op: 'patch',
      id: 'big',
      edits: [{ find: 'x', replace: 'y'.repeat(BODY_MAX_CHARS + 1) }],
    });

    expect(refused.content).toContain(
      `"body" is ${BODY_MAX_CHARS + 1} chars, limit ${BODY_MAX_CHARS}`,
    );
  });
});

describe('what a page is anchored to', () => {
  it('names the files a page describes, and says when the answer cannot be known', async () => {
    await call('page', {
      op: 'put',
      id: 'car-api',
      kind: 'feature',
      title: 'Car API',
      summary: 'What the controller exposes.',
      body: 'Speed is set in scripts/Car.cs:2 and the bar in scripts/Hud.cs.',
    });

    const got = await call('page', { op: 'get', id: 'car-api' });

    // This root is a temporary directory with no repository, so "unknown" is reported
    // rather than the "nothing changed" a reader would otherwise assume.
    expect(got.content).toContain(
      'source:  no repository; names scripts/Car.cs, scripts/Hud.cs — changed since: unknown',
    );
  });

  it('says a page that names no file has nothing to go stale', async () => {
    await call('page', {
      ...projectPage,
      body: 'A page about intent and decisions.',
    });

    expect((await call('page', { op: 'get', id: 'project' })).content).toContain(
      'names no file — nothing under it can go stale',
    );
  });

  it('reports the pages whose code moved, through the tool', async () => {
    await call('page', { ...projectPage, body: 'Physics lives in scripts/Car.cs.' });

    const stale = await call('page', { op: 'stale' });

    expect(stale.ok).toBe(true);
    expect(stale.content).toContain('no page names a file that changed after the page was written');
    expect(stale.content).toContain('page {"op":"get","id":"<id>"}');
  });

  it('takes a limit for stale, and no id for it', async () => {
    const refused = await call('page', { op: 'stale', id: 'project' });
    expect(refused.ok).toBe(false);
    expect(refused.content).toContain('op "stale" does not take "id"');

    const limited = await call('page', { op: 'stale', limit: 3 });
    expect(limited.ok).toBe(true);
  });

  it('answers coverage through the tool, with the same argument rules as stale', async () => {
    const refused = await call('page', { op: 'coverage', id: 'project' });
    expect(refused.ok).toBe(false);
    expect(refused.content).toContain('op "coverage" does not take "id"');

    expect((await call('page', { op: 'coverage', limit: 0 })).ok).toBe(false);

    const coverage = await call('page', { op: 'coverage' });
    expect(coverage.ok).toBe(true);
    // This root is not a repository, so there is nothing to list — which must not read as
    // "everything is documented".
    expect(coverage.content).toContain('this project has none to ask');

    expect((await call('page', { op: 'coverage', limit: 5 })).ok).toBe(true);
  });
});

describe('page list and delete', () => {
  it('lists summaries and never a body', async () => {
    await call('page', projectPage);
    await call('page', {
      op: 'put',
      id: 'auth',
      kind: 'feature',
      title: 'Authentication',
      summary: 'Who is asking.',
      body: 'x'.repeat(2000),
      pin: true,
    });

    const listed = await call('page', { op: 'list' });

    expect(listed.content).toContain('Pages (2):');
    expect(listed.content).toContain('- auth * [feature] Authentication — Who is asking.');
    expect(listed.content).not.toContain('xxxx');
  });

  it('filters by kind and by status, and says so when nothing matches', async () => {
    await call('page', projectPage);
    await call('page', {
      op: 'put',
      id: 'old',
      kind: 'decision',
      title: 'Old call',
      summary: 'Superseded.',
      status: 'archived',
    });

    expect((await call('page', { op: 'list', kind: 'decision' })).content).toContain('old');
    expect((await call('page', { op: 'list', status: 'archived' })).content).toContain('old');
    expect((await call('page', { op: 'list', status: 'current' })).content).toContain('project');

    const none = await call('page', { op: 'list', kind: 'note' });
    expect(none.content).toContain('no pages match that filter');
  });

  it('points a project with no pages at the singleton pages to write first', async () => {
    const listed = await call('page', { op: 'list' });

    expect(listed.content).toContain('no knowledge base yet');
    expect(listed.content).toContain('project, user-intent, onboarding');
    expect(listed.content).toContain('op "init"');
  });

  it('refuses an unknown kind or status in a filter', async () => {
    expect((await call('page', { op: 'list', kind: 'wiki' })).content).toContain(
      'kind must be one of',
    );
    expect((await call('page', { op: 'list', status: 'maybe' })).content).toContain(
      'status must be one of',
    );
  });

  it('deletes a page and names the children it promoted', async () => {
    await call('page', projectPage);
    await call('page', {
      op: 'put',
      id: 'auth',
      kind: 'feature',
      title: 'Auth',
      summary: 'S',
      parent: 'project',
    });

    const deleted = await call('page', { op: 'delete', id: 'project' });

    expect(deleted.content).toContain('Deleted page project');
    expect(deleted.content).toContain('Children moved to the root: auth');
    expect(pages.get('auth')?.parent).toBeNull();
    expect((await call('page', { op: 'delete', id: 'project' })).content).toContain('No page');
  });
});

describe('page init', () => {
  it('scaffolds the three reserved pages and says what to do with them', async () => {
    const inited = await call('page', { op: 'init' });

    expect(inited.ok).toBe(true);
    expect(inited.content).toContain(
      'Scaffolded 3 template page(s): project, user-intent, onboarding.',
    );
    expect(inited.content).toContain('"status":"current"');
    expect(pages.count()).toBe(3);
    expect(pages.get('onboarding')?.body).toContain('project_brief');
  });

  it('overwrites nothing on a second call, filled in or not', async () => {
    await call('page', { op: 'init' });
    await call('page', {
      op: 'put',
      id: 'project',
      summary: 'Filled in by hand.',
      status: 'current',
    });

    const again = await call('page', { op: 'init' });

    expect(again.content).toContain('Nothing to scaffold');
    expect(again.content).toContain('never overwrites');
    expect(pages.get('project')?.summary).toBe('Filled in by hand.');
    expect(pages.get('project')?.status).toBe('current');
  });

  it('takes no argument but project, and says so without writing anything', async () => {
    const refused = await call('page', { op: 'init', id: 'project' });

    expect(refused.ok).toBe(false);
    expect(refused.content).toContain('op "init" does not take "id"');
    expect(pages.count()).toBe(0);
  });

  it('leaves the scaffolded project readable through the brief, with no template body in it', async () => {
    await call('page', { op: 'init' });

    const brief = await call('project_brief', {});

    expect(brief.content).toContain('- project (stale): TEMPLATE');
    expect(brief.content).toContain('- onboarding (stale): TEMPLATE');
    expect(brief.content).not.toContain('replace every');
  });

  it('reaches a declared project, so a supervisor can scaffold a worker root', async () => {
    const refused = await call('page', { op: 'init', project: 'worker' });

    expect(refused.ok).toBe(false);
    expect(refused.content).toContain('unknown project "worker"');
    expect(pages.count()).toBe(0);
  });
});

describe('page link, unlink and links', () => {
  it('links a page to a task and lists the edge from either side', async () => {
    await call('page', {
      op: 'put',
      id: 'auth',
      kind: 'feature',
      title: 'Auth',
      summary: 'Who is asking.',
    });
    const task = await tasks.start('Build authentication');

    const linked = await call('page', {
      op: 'link',
      from: 'page:auth',
      rel: 'documents',
      to: `task:${task.meta.id}`,
    });
    expect(linked.content).toBe(`Linked page:auth -[documents]-> task:${task.meta.id}`);

    const fromPage = await call('page', { op: 'links', ref: 'page:auth' });
    expect(fromPage.content).toContain(`- page:auth -[documents]-> task:${task.meta.id}`);

    const fromTask = await call('page', { op: 'links', ref: `task:${task.meta.id}` });
    expect(fromTask.content).toContain('page:auth');
  });

  it('refuses an edge to something that is not there, and a ref in the wrong shape', async () => {
    await call('page', { op: 'put', id: 'auth', kind: 'feature', title: 'Auth', summary: 'S' });

    const refused = await call('page', {
      op: 'link',
      from: 'page:auth',
      rel: 'documents',
      to: 'page:nope',
    });
    expect(refused.content).toContain('Refused (guard)');
    expect(refused.content).toContain('is not in this state root');

    expect((await call('page', { op: 'links', ref: 'auth' })).content).toContain(
      'must look like "task:<id>" or "page:<id>"',
    );
    expect(
      (await call('page', { op: 'link', from: 'page:auth', rel: 'Documents', to: 'page:auth' }))
        .content,
    ).toContain('Refused (schema)');
  });

  it('unlinks once, and reports that the second time there was nothing to remove', async () => {
    await call('page', {
      op: 'put',
      id: 'auth',
      kind: 'feature',
      title: 'Auth',
      summary: 'S',
    });
    await call('page', { op: 'put', id: 'tokens', kind: 'feature', title: 'Tokens', summary: 'S' });
    await call('page', { op: 'link', from: 'page:auth', rel: 'see-also', to: 'page:tokens' });

    const removed = await call('page', {
      op: 'unlink',
      from: 'page:auth',
      rel: 'see-also',
      to: 'page:tokens',
    });
    expect(removed.content).toContain('Unlinked page:auth -[see-also]-> page:tokens');

    const again = await call('page', {
      op: 'unlink',
      from: 'page:auth',
      rel: 'see-also',
      to: 'page:tokens',
    });
    expect(again.ok).toBe(false);
    expect(again.content).toContain('No link');
  });

  it('filters by direction and reports a node with no edges', async () => {
    await call('page', { op: 'put', id: 'auth', kind: 'feature', title: 'Auth', summary: 'S' });
    await call('page', { op: 'put', id: 'tokens', kind: 'feature', title: 'Tokens', summary: 'S' });
    await call('page', { op: 'link', from: 'page:tokens', rel: 'implements', to: 'page:auth' });

    expect(
      (await call('page', { op: 'links', ref: 'page:auth', direction: 'in' })).content,
    ).toContain('implements');
    expect(
      (await call('page', { op: 'links', ref: 'page:auth', direction: 'out' })).content,
    ).toContain('no links touch page:auth');
    expect(
      (await call('page', { op: 'links', ref: 'page:auth', direction: 'sideways' })).content,
    ).toContain('direction must be one of');
  });
});

describe('search', () => {
  it('returns one line per hit with a snippet, across pages and tasks', async () => {
    await call('page', {
      ...projectPage,
      body: 'The runtime validates every write against the skill schema.',
    });
    await tasks.start('Add a search tool');

    const found = await call('search', { query: 'validates' });

    expect(found.content).toContain('1 hit(s) for "validates":');
    expect(found.content).toContain('- page:project skillState:');
    expect(found.content).toContain('[validates]');
  });

  it('explains an empty result instead of returning nothing at all', async () => {
    await call('page', projectPage);

    const found = await call('search', { query: 'kubernetes' });

    expect(found.ok).toBe(true);
    expect(found.content).toContain('nothing matches "kubernetes"');
    expect(found.content).toContain('Every word must appear');
  });

  it('names the nearest pages on a miss, and the move that ends the miss', async () => {
    const stored = await call('page', {
      op: 'put',
      id: 'roads',
      kind: 'feature',
      title: 'Road network',
      summary: 'How the roads are laid out.',
    });
    expect(stored.ok).toBe(true);

    const found = await call('search', { query: 'RoadNetwork' });

    expect(found.ok).toBe(true);
    expect(found.content).toContain('nothing matches "RoadNetwork"');
    expect(found.content).toContain('Nearest pages by topic');
    expect(found.content).toContain('- roads: Road network');
    expect(found.content).toContain('(shares: roadnetwork)');
    expect(found.content).toContain('"symbols"');
  });

  it('points a task-only miss at nothing but tasks, since pages were not being searched', async () => {
    await call('page', {
      op: 'put',
      id: 'roads',
      kind: 'feature',
      title: 'Road network',
      summary: 'How the roads are laid out.',
    });

    const found = await call('search', { query: 'RoadNetwork', kind: 'task' });

    expect(found.ok).toBe(true);
    expect(found.content).not.toContain('Nearest pages');
  });

  it('says a project with no pages has no knowledge base, rather than reporting a clean miss', async () => {
    const found = await call('search', { query: 'anything at all' });

    expect(found.ok).toBe(true);
    expect(found.content).toContain('this project has no knowledge base yet');
    expect(found.content).toContain('op":"init"');
    expect(found.content).not.toContain('Nearest pages');
  });

  it('takes a kind and a limit, and refuses anything else', async () => {
    await call('page', { ...projectPage, body: 'shared word here' });
    await tasks.start('a task with the same shared word');

    expect((await call('search', { query: 'shared', kind: 'page' })).content).toContain('1 hit(s)');
    expect((await call('search', { query: 'shared', limit: 1 })).content).toContain('1 hit(s)');
    expect((await call('search', { query: 'shared', kind: 'widget' })).content).toContain(
      'kind must be "task" or "page"',
    );
    expect((await call('search', { query: 'shared', fuzzy: true })).content).toContain(
      'search does not take "fuzzy"',
    );
    expect((await call('search', {})).content).toContain('missing required argument: query');
  });
});

describe('the project argument', () => {
  it('surfaces an undeclared project instead of falling back to this one', async () => {
    const refused = await call('page', { op: 'list', project: 'worker' });

    expect(refused.ok).toBe(false);
    expect(refused.content).toContain('unknown project "worker"');
  });
});
