import type { PageStorePort } from './ports.js';
import { SINGLETON_PAGE_KINDS } from './schema.js';
import type { SingletonPageKind } from './schema.js';

/**
 * The scaffolding for a project's first three pages — the "how do I start here" half of the
 * knowledge base.
 *
 * A cold agent facing an empty project has two bad options: ask the user questions the project
 * could answer itself, or guess and write nothing down. Templates remove both, because they turn
 * "document this project" (unbounded) into "answer these headings" (bounded). They are stored as
 * pages rather than printed as advice so that the work of filling them in is ordinary page
 * editing, visible in the brief and findable by search from the moment it exists.
 *
 * Placeholders are written `<…>` and every template says so at the top: a half-filled page must
 * never be mistaken for a finished one.
 */
export interface PageTemplate {
  title: string;
  /** What the brief shows before anybody has filled the page in, so it says "template" plainly. */
  summary: string;
  body: string;
}

export const PAGE_TEMPLATES: Record<SingletonPageKind, PageTemplate> = {
  project: {
    title: 'What this project is',
    summary:
      'TEMPLATE — fill in: what this project does, its stack and layout, and the commands that build, test and run it.',
    body: [
      '# <project name>',
      '',
      'TEMPLATE — replace every `<…>` below, then put this page again with `"status":"current"`.',
      '',
      '## What it is',
      '<One paragraph: what this project does, for whom, and what "working" looks like.>',
      '',
      '## Stack',
      '<Language and runtime with their versions, frameworks, storage, and where dependencies are declared.>',
      '',
      '## Layout',
      '<The directories that matter, one line each. Point at paths instead of pasting code: the repository holds the code and stays current, a copy here does not.>',
      '',
      '## Commands',
      '',
      '    install:  <command>',
      '    build:    <command>',
      '    test:     <command>',
      '    lint:     <command>',
      '    run:      <command>',
      '',
      '## Conventions',
      '<Naming, formatting, commit style, where tests live — anything a contributor must not guess.>',
      '',
      '## Sharp edges',
      '<The parts that break easily, what breaks them, and what to do instead.>',
    ].join('\n'),
  },
  'user-intent': {
    title: 'What the user wants',
    summary:
      'TEMPLATE — fill in: the outcome the user wants, the priorities behind it, the constraints, and what is out of scope.',
    body: [
      '# What the user wants from this project',
      '',
      'TEMPLATE — replace every `<…>` below, then put this page again with `"status":"current"`.',
      '',
      '## Outcome',
      '<What the user is after, in their own words where you have them. This is the answer to "why does this project exist".>',
      '',
      '## Priorities',
      '',
      '1. <What wins when two good options conflict.>',
      '2. <What comes next.>',
      '',
      '## Constraints',
      '<Deadlines, platforms, compatibility, budget, dependencies that cannot change, and rules that come from outside the project.>',
      '',
      '## Out of scope',
      '<What looks like part of the job but is not, and why. This is the section that saves the most wasted work.>',
      '',
      '## How to work with the user',
      '<Their language, how much to explain before acting, what needs confirming first, and what verification they expect to see.>',
    ].join('\n'),
  },
  onboarding: {
    title: 'Starting work here with no context',
    summary:
      'TEMPLATE — fill in: the reading order and the habits of an agent that starts work in this project knowing nothing.',
    body: [
      '# Starting work here with no context',
      '',
      'TEMPLATE — replace every `<…>` below, then put this page again with `"status":"current"`.',
      'The order below is generic; the sections under it are what only this project can answer.',
      '',
      'You have been dropped into this project mid-flight. Read in this order, cheapest first:',
      '',
      '1. `project_brief` — one line per page and no bodies: the map of what is written down.',
      '2. `page {"op":"get","id":"project"}` — what the project is, and the commands that build and test it.',
      '3. `page {"op":"get","id":"user-intent"}` — what the user wants, what is out of scope, and what to confirm before acting.',
      '4. `task_show` — the state Σ of the task in flight, if there is one. It survives compaction and restarts, so trust it over your recollection of the conversation.',
      '5. `search {"query":"…"}` — before reading a file end to end, and before asking the user something this project may already have written down.',
      '',
      '## Working here',
      '<The branch to start from. The one command that proves the project is healthy. The files nobody edits, and why. Whatever else a newcomer gets wrong on the first day.>',
      '',
      '## While you work',
      '',
      '- Keep Σ current: `task_patch` after every meaningful step, with only the fields that changed.',
      '- Write down what you learn as you learn it, not at the end: a `decision` page for a choice and the reason behind it, a `feature` page for something you built.',
      '- One informative line per page `summary` — it is all a cold agent sees before deciding whether to open the page.',
      '- Point at the code that matters instead of copying it into a page.',
      '',
      '## Before you stop',
      '',
      '- Run <the verification commands> and record each one in Σ under `verifications` with its real result. Never record a check you did not run.',
      '- Update `project` if the layout or the commands changed; put `user-intent` straight if you learned something new about what the user wants.',
      '- `task_finish` with the outcome — or leave `next.action` and `next.risk` saying exactly where the next session picks up.',
    ].join('\n'),
  },
};

/** Every template, as the store accepts it: a singleton page lives under its kind as its id. */
export function templatePage(kind: SingletonPageKind): Record<string, unknown> {
  const template = PAGE_TEMPLATES[kind];
  return {
    id: kind,
    kind,
    title: template.title,
    summary: template.summary,
    body: template.body,
    // A template is a shape to fill in, not a statement about the project, and the brief prints
    // the status next to the summary — so an unfilled page cannot read as documented truth.
    status: 'stale',
  };
}

export interface InitReport {
  /** Ids this call created, in the order the brief will show them. */
  created: string[];
  /** Ids that were already there and were left exactly as they were. */
  existing: string[];
}

/**
 * Scaffolds the reserved pages a project is missing and leaves the rest alone.
 *
 * Never overwriting is the whole contract. `init` is what an agent calls first in a project it
 * knows nothing about, which makes it the one call most likely to arrive after the pages it would
 * write have already been filled in by somebody who did know — and the filled-in description of a
 * project is the most valuable thing in its database. Rewriting one has to be an explicit `put`.
 */
export function initPages(pages: PageStorePort): InitReport {
  const created: string[] = [];
  const existing: string[] = [];
  for (const kind of SINGLETON_PAGE_KINDS) {
    if (pages.get(kind) !== null) {
      existing.push(kind);
      continue;
    }
    pages.put(templatePage(kind));
    created.push(kind);
  }
  return { created, existing };
}

/**
 * What `init` answers: what appeared, what was already there, and how to fill a template in.
 * The report carries the next call, because an agent that just scaffolded three stale pages has
 * no other way to learn that leaving them stale is the one thing it must not do.
 */
export function renderInitReport(report: InitReport): string {
  if (report.created.length === 0) {
    return [
      `Nothing to scaffold: ${report.existing.join(', ')} already exist.`,
      'init never overwrites a page — read one with op "get" and change it with op "put".',
    ].join('\n');
  }

  const first = report.created[0] ?? SINGLETON_PAGE_KINDS[0];
  const lines = [
    `Scaffolded ${report.created.length} template page(s): ${report.created.join(', ')}.`,
  ];
  if (report.existing.length > 0) lines.push(`Left as they were: ${report.existing.join(', ')}.`);
  lines.push(
    `Each is marked (stale) until it is filled in: read one with page {"op":"get","id":"${first}"}, ` +
      'replace every <…> in its body, and send the same put with "status":"current".',
    'A cold session sees only the summaries, so make each one line say what the page holds.',
  );
  return lines.join('\n');
}
