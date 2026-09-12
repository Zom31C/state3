import { isRejectCategory } from '../core/rejections.js';
import type { RejectCategory } from '../core/rejections.js';
import { LINK_DIRECTIONS, type KbResolver, type KbStores, type LinkRef } from '../kb/ports.js';
import type { LinkDirection } from '../kb/ports.js';
import { SUGGESTED_LINK_RELS } from '../kb/links.js';
import {
  PAGE_KINDS,
  PAGE_STATUSES,
  SINGLETON_PAGE_KINDS,
  isPageKind,
  isPageStatus,
} from '../kb/schema.js';
import type { PageRecord, PageSummary } from '../kb/schema.js';
import { renderProjectBrief } from '../kb/brief.js';
import { initPages, renderInitReport } from '../kb/templates.js';
import type { SearchHit } from '../kb/search.js';
import { MAX_SEARCH_LIMIT } from '../kb/search.js';
import {
  classifyError,
  failure,
  guarded,
  optionalPositiveInt,
  optionalString,
  PROJECT_ARG,
  requireString,
  success,
} from './tools.js';
import type { TaskToolDefinition, ToolResult } from './tools.js';

/** The rendered link lines of one page, as `page get` shows them. */
type EdgeList = readonly string[];

/**
 * The knowledge-base tools: three declarations — `project_brief`, `page` and `search`.
 *
 * Every page operation is one `op` on one tool rather than a tool each, because a host sends
 * the whole declaration list to the model on every session: a dozen tools that each cost a
 * paragraph is a tax on every turn, while one tool with a documented `op` costs one.
 */
export const PAGE_OPS = [
  'get',
  'put',
  'list',
  'delete',
  'init',
  'link',
  'unlink',
  'links',
] as const;

export type PageOp = (typeof PAGE_OPS)[number];

/** Arguments each operation takes; anything else is refused rather than ignored. */
const OP_ARGS: Record<PageOp, readonly string[]> = {
  get: ['id'],
  put: ['id', 'kind', 'title', 'summary', 'body', 'parent', 'status', 'pin'],
  list: ['kind', 'status'],
  delete: ['id'],
  init: [],
  link: ['from', 'rel', 'to'],
  unlink: ['from', 'rel', 'to'],
  links: ['ref', 'direction'],
};

const SHARED_ARGS: readonly string[] = ['op', 'project'];

/** The page fields `put` forwards; `id` is handled separately because it is required. */
const PUT_FIELDS = ['kind', 'title', 'summary', 'body', 'parent', 'status', 'pin'] as const;

const KB_HINTS: Partial<Record<RejectCategory, string>> = {
  'unknown-key':
    'remove the arguments this operation does not take; the tool description lists them per op.',
  guard:
    'a knowledge-base rule refused this write; follow the message above — a singleton page lives at its kind name, a parent must exist, and nothing may become its own ancestor.',
  schema:
    'check the values against the page schema: a lowercase id, one of the listed kinds, a non-empty title and summary.',
  'type-coercion':
    'check value types: text as strings, pin as a boolean, and null (not the string "null") to clear a parent.',
};

const KB_FALLBACK_HINT =
  're-read the page with op "get" and send only the fields you mean to change.';

function kbHint(category: string): string {
  if (!isRejectCategory(category)) return KB_FALLBACK_HINT;
  return KB_HINTS[category] ?? KB_FALLBACK_HINT;
}

/**
 * Refusals read the same way as a rejected task patch: what was wrong, that nothing changed,
 * and what to do instead. A model that has to guess which of the three it is looking at
 * retries blindly.
 */
export function kbFailure(err: unknown): ToolResult {
  const info = classifyError(err);
  if (info.category === undefined) {
    return failure(info.message === '' ? 'unknown error' : info.message);
  }
  return failure(
    [
      `Refused (${info.category}): ${info.message}`,
      'Nothing was written.',
      `Hint: ${kbHint(info.category)}`,
    ].join('\n'),
  );
}

type ArgCheck<T> = { ok: true; value: T } | { ok: false; message: string };

/** Refuses arguments the chosen operation does not take, so a typo cannot be silently dropped. */
function checkArgs(args: Record<string, unknown>, op: PageOp): string | null {
  const allowed = new Set([...SHARED_ARGS, ...OP_ARGS[op]]);
  const extra = Object.keys(args).filter((name) => !allowed.has(name));
  if (extra.length === 0) return null;
  return `op "${op}" does not take ${extra.map((name) => `"${name}"`).join(', ')} (it takes: ${
    OP_ARGS[op].join(', ') || 'nothing'
  })`;
}

/** `"page:auth"` → `{ kind: 'page', id: 'auth' }`; the form the link arguments use. */
function parseRef(raw: string, label: string): ArgCheck<LinkRef> {
  const at = raw.indexOf(':');
  if (at <= 0 || at === raw.length - 1) {
    return {
      ok: false,
      message: `${label} must look like "task:<id>" or "page:<id>", got "${raw}"`,
    };
  }
  return { ok: true, value: { kind: raw.slice(0, at), id: raw.slice(at + 1) } };
}

function refText(ref: LinkRef): string {
  return `${ref.kind}:${ref.id}`;
}

/** One page in full: the header line, the fields, its edges, then the body verbatim. */
export function renderPage(page: PageRecord, edges: EdgeList): string {
  const flags = [page.status, page.pin ? 'pinned' : ''].filter((flag) => flag !== '');
  const head = [`page ${page.id} [${page.kind}] (${flags.join(', ')})`];
  const fields = [
    `title:   ${page.title}`,
    `summary: ${page.summary}`,
    `parent:  ${page.parent ?? 'none'}`,
    `updated: ${page.updatedAt}`,
  ];
  const links =
    edges.length === 0 ? ['links:   none'] : ['links:', ...edges.map((edge) => `  ${edge}`)];
  return [...head, ...fields, ...links, '', page.body].join('\n');
}

/** One line per page, and never a body: this is the cheap level of the token pyramid. */
export function renderPageLine(page: PageSummary): string {
  const pin = page.pin ? ' *' : '';
  const status = page.status === 'current' ? '' : ` (${page.status})`;
  return `- ${page.id}${pin} [${page.kind}]${status} ${page.title} — ${page.summary}`;
}

export function renderHit(hit: SearchHit): string {
  return `- ${hit.kind}:${hit.id} ${hit.title}: ${hit.snippet}`;
}

function resolveKb(
  kb: KbResolver,
  args: Record<string, unknown>,
): { ok: true; stores: KbStores } | { ok: false; result: ToolResult } {
  const project = optionalString(args, 'project');
  if (!project.ok) return { ok: false, result: failure(project.message) };
  try {
    return { ok: true, stores: kb.kb(project.value) };
  } catch (err) {
    return { ok: false, result: kbFailure(err) };
  }
}

async function pageOp(kb: KbResolver, args: Record<string, unknown>): Promise<ToolResult> {
  const op = requireString(args, 'op');
  if (!op.ok) return failure(op.message);
  if (!(PAGE_OPS as readonly string[]).includes(op.value)) {
    return failure(`op must be one of: ${PAGE_OPS.join(', ')} (got "${op.value}")`);
  }
  const chosen = op.value as PageOp;

  const unexpected = checkArgs(args, chosen);
  if (unexpected !== null) return failure(unexpected);

  const resolved = resolveKb(kb, args);
  if (!resolved.ok) return resolved.result;
  const { pages, links } = resolved.stores;

  try {
    switch (chosen) {
      case 'get': {
        const id = requireString(args, 'id');
        if (!id.ok) return failure(id.message);
        const page = pages.get(id.value);
        if (page === null) {
          // An empty project is pointed at the scaffolding rather than at a listing of nothing:
          // `page get project` is the first call a cold agent makes, so it is the call that
          // should say how the three reserved pages come to exist.
          const empty = pages.count() === 0;
          return failure(
            `No page "${id.value}"${empty ? ' — this project has no pages yet' : ''}.\n` +
              (empty
                ? 'Scaffold the three reserved pages with op "init", or write this one with op "put".'
                : 'List what exists with op "list", or write it with op "put".'),
          );
        }
        const edges = links
          .linksOf({ kind: 'page', id: page.id })
          .map((edge) =>
            edge.src.kind === 'page' && edge.src.id === page.id
              ? `-[${edge.rel}]-> ${refText(edge.dst)}`
              : `${refText(edge.src)} -[${edge.rel}]->`,
          );
        return success(renderPage(page, edges));
      }

      case 'put': {
        const id = requireString(args, 'id');
        if (!id.ok) return failure(id.message);

        const input: Record<string, unknown> = { id: id.value };
        // `field in args` rather than a truthiness test: `parent: null` clears the parent and
        // must survive, while an absent field keeps the stored value.
        for (const field of PUT_FIELDS) {
          if (field in args) input[field] = args[field];
        }

        const existed = pages.get(id.value) !== null;
        const stored = pages.put(input);
        const verb = existed ? 'Updated' : 'Stored';
        return success(
          `${verb} page ${stored.id} [${stored.kind}] (${stored.status})\n` +
            `title:   ${stored.title}\nsummary: ${stored.summary}`,
        );
      }

      case 'list': {
        const kind = optionalString(args, 'kind');
        if (!kind.ok) return failure(kind.message);
        if (kind.value !== undefined && !isPageKind(kind.value)) {
          return failure(`kind must be one of: ${PAGE_KINDS.join(', ')} (got "${kind.value}")`);
        }
        const status = optionalString(args, 'status');
        if (!status.ok) return failure(status.message);
        if (status.value !== undefined && !isPageStatus(status.value)) {
          return failure(
            `status must be one of: ${PAGE_STATUSES.join(', ')} (got "${status.value}")`,
          );
        }

        const found = pages.list({
          ...(kind.value === undefined ? {} : { kind: kind.value }),
          ...(status.value === undefined ? {} : { statuses: [status.value] }),
        });
        if (found.length === 0) {
          const empty = pages.count() === 0;
          return success(
            `no pages${empty ? ' — this project has no knowledge base yet' : ' match that filter'}.\n` +
              `Singleton pages to start with: ${SINGLETON_PAGE_KINDS.join(', ')}` +
              `${empty ? ' — op "init" scaffolds all three as templates.' : '.'}`,
          );
        }
        return success(`Pages (${found.length}):\n${found.map(renderPageLine).join('\n')}`);
      }

      case 'delete': {
        const id = requireString(args, 'id');
        if (!id.ok) return failure(id.message);
        if (pages.get(id.value) === null) return failure(`No page "${id.value}".`);
        // Named before the delete, because afterwards they are root pages and nothing records
        // that they were moved: a silent re-parenting is how a tree gets lost.
        const children = pages.list({ parent: id.value }).map((page) => page.id);
        pages.delete(id.value);
        const moved =
          children.length === 0 ? '' : ` Children moved to the root: ${children.join(', ')}.`;
        return success(`Deleted page ${id.value}.${moved}`);
      }

      case 'init':
        return success(renderInitReport(initPages(pages)));

      case 'link':
      case 'unlink': {
        const from = requireString(args, 'from');
        if (!from.ok) return failure(from.message);
        const to = requireString(args, 'to');
        if (!to.ok) return failure(to.message);
        const rel = requireString(args, 'rel');
        if (!rel.ok) return failure(rel.message);
        const source = parseRef(from.value, 'from');
        if (!source.ok) return failure(source.message);
        const target = parseRef(to.value, 'to');
        if (!target.ok) return failure(target.message);

        if (chosen === 'link') {
          const edge = links.link(source.value, rel.value, target.value);
          return success(`Linked ${refText(edge.src)} -[${edge.rel}]-> ${refText(edge.dst)}`);
        }
        const removed = links.unlink(source.value, rel.value, target.value);
        return removed
          ? success(`Unlinked ${refText(source.value)} -[${rel.value}]-> ${refText(target.value)}`)
          : failure(
              `No link ${refText(source.value)} -[${rel.value}]-> ${refText(target.value)}.\n` +
                'List the edges with op "links".',
            );
      }

      case 'links': {
        const ref = requireString(args, 'ref');
        if (!ref.ok) return failure(ref.message);
        const parsed = parseRef(ref.value, 'ref');
        if (!parsed.ok) return failure(parsed.message);
        const direction = optionalString(args, 'direction');
        if (!direction.ok) return failure(direction.message);
        if (
          direction.value !== undefined &&
          !(LINK_DIRECTIONS as readonly string[]).includes(direction.value)
        ) {
          return failure(`direction must be one of: ${LINK_DIRECTIONS.join(', ')}`);
        }

        const edges = links.linksOf(parsed.value, direction.value as LinkDirection | undefined);
        if (edges.length === 0) return success(`no links touch ${refText(parsed.value)}`);
        return success(
          `Links of ${refText(parsed.value)} (${edges.length}):\n` +
            edges
              .map((edge) => `- ${refText(edge.src)} -[${edge.rel}]-> ${refText(edge.dst)}`)
              .join('\n'),
        );
      }
    }
  } catch (err) {
    return kbFailure(err);
  }
}

async function searchKb(kb: KbResolver, args: Record<string, unknown>): Promise<ToolResult> {
  const resolved = resolveKb(kb, args);
  if (!resolved.ok) return resolved.result;

  const query = requireString(args, 'query');
  if (!query.ok) return failure(query.message);
  const kind = optionalString(args, 'kind');
  if (!kind.ok) return failure(kind.message);
  if (kind.value !== undefined && kind.value !== 'task' && kind.value !== 'page') {
    return failure(`kind must be "task" or "page" (got "${kind.value}")`);
  }
  const limit = optionalPositiveInt(args, 'limit');
  if (!limit.ok) return failure(limit.message);

  const unexpected = Object.keys(args).filter(
    (name) => !['query', 'kind', 'limit', 'project'].includes(name),
  );
  if (unexpected.length > 0) {
    return failure(`search does not take ${unexpected.map((name) => `"${name}"`).join(', ')}`);
  }

  try {
    const hits = resolved.stores.pages.search(query.value, {
      ...(kind.value === undefined ? {} : { kind: kind.value }),
      ...(limit.value === undefined ? {} : { limit: limit.value }),
    });
    if (hits.length === 0) {
      return success(
        `nothing matches "${query.value}".\n` +
          'Every word must appear in the same task or page; try fewer words, or list pages with the page tool.',
      );
    }
    return success(
      `${hits.length} hit(s) for "${query.value}":\n${hits.map(renderHit).join('\n')}`,
    );
  } catch (err) {
    return kbFailure(err);
  }
}

async function briefOp(kb: KbResolver, args: Record<string, unknown>): Promise<ToolResult> {
  const unexpected = Object.keys(args).filter((name) => name !== 'project');
  if (unexpected.length > 0) {
    return failure(
      `project_brief does not take ${unexpected.map((name) => `"${name}"`).join(', ')}`,
    );
  }

  const resolved = resolveKb(kb, args);
  if (!resolved.ok) return resolved.result;

  try {
    return success(renderProjectBrief(resolved.stores.pages));
  } catch (err) {
    return kbFailure(err);
  }
}

const BRIEF_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    project: PROJECT_ARG,
  },
  required: [],
  additionalProperties: false,
};

const PAGE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    op: {
      type: 'string',
      enum: [...PAGE_OPS],
      description:
        'get: read one page with its body and its links (id). put: create or update a page (id, and any of kind/title/summary/body/parent/status/pin — a field you omit keeps its value). list: page ids with their one-line summaries, no bodies (optional kind, status). delete: remove a page (id); its children become root pages. init: scaffold the reserved pages project, user-intent and onboarding as templates to fill in, leaving any that already exist untouched (no other arguments). link/unlink: add or remove an edge (from, rel, to). links: the edges of a node (ref, optional direction).',
    },
    id: {
      type: 'string',
      description:
        'Page id: lowercase letters, digits, "-" and "_". The singleton pages are addressed by their kind: "project", "user-intent", "onboarding".',
    },
    kind: {
      type: 'string',
      enum: [...PAGE_KINDS],
      description: `What the page is. ${SINGLETON_PAGE_KINDS.join(', ')} exist once per project and their id is the kind; feature, decision and note may repeat.`,
    },
    title: { type: 'string', description: 'Short human title, up to 200 chars.' },
    summary: {
      type: 'string',
      description:
        'One line, up to 200 chars, saying what this page holds. This is what a cold agent sees before deciding to read the body, so it carries the weight.',
    },
    body: {
      type: 'string',
      description:
        'The page itself in markdown, up to 20000 chars. Point at the code that matters instead of copying it.',
    },
    parent: {
      type: ['string', 'null'],
      description:
        'Parent page id, or null to make this a root page. Omit to keep the current parent.',
    },
    status: {
      type: 'string',
      enum: [...PAGE_STATUSES],
      description:
        'current (default), stale (probably out of date — say so in the summary), or archived (kept, but left out of the brief).',
    },
    pin: {
      type: 'boolean',
      description:
        'Keep this page in the cold-start brief even when it has not changed in a while.',
    },
    from: { type: 'string', description: 'Edge source, as "task:<id>" or "page:<id>".' },
    rel: {
      type: 'string',
      description: `Edge name: lowercase letters, digits, "-" or "_". In common use: ${SUGGESTED_LINK_RELS.join(', ')}.`,
    },
    to: { type: 'string', description: 'Edge target, as "task:<id>" or "page:<id>".' },
    ref: {
      type: 'string',
      description: 'Node whose edges to list, as "task:<id>" or "page:<id>".',
    },
    direction: {
      type: 'string',
      enum: [...LINK_DIRECTIONS],
      description: 'Which edges of ref to list. Default both.',
    },
    project: PROJECT_ARG,
  },
  required: ['op'],
  additionalProperties: false,
};

const SEARCH_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description:
        'Words to look for. Every word must appear in the same task or page; tasks (goal and whole state) and pages (title, summary, body) are searched together. A substring of an identifier also works.',
    },
    kind: {
      type: 'string',
      enum: ['task', 'page'],
      description: 'Search only tasks or only pages. Default both.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_SEARCH_LIMIT,
      description: 'At most this many hits, best match first. Default 10.',
    },
    project: PROJECT_ARG,
  },
  required: ['query'],
  additionalProperties: false,
};

export function createKbTools(kb: KbResolver): TaskToolDefinition[] {
  return [
    {
      name: 'project_brief',
      description:
        'Read this first in a project you have no context in: one line per knowledge-base page — what the project is, what the user wants from it, how to start working in it, what each feature does and why decisions were taken — inside a fixed budget, and never a page body. It is the map, not the territory: open a page with the page tool, or ask search.',
      inputSchema: BRIEF_SCHEMA,
      handler: (args) => guarded(args, (a) => briefOp(kb, a)),
    },
    {
      name: 'page',
      description:
        'Read and write the project knowledge base: the pages that say what this project is, what the user wants from it, how to start working in it, what each feature does and why decisions were taken. One tool, chosen by op. A page id with kind, a one-line summary and a markdown body; summaries are what a cold agent reads first, so keep them informative. In a project with no pages yet, op "init" scaffolds the three reserved ones as templates. Refused writes report the rule that was broken and change nothing.',
      inputSchema: PAGE_SCHEMA,
      handler: (args) => guarded(args, (a) => pageOp(kb, a)),
    },
    {
      name: 'search',
      description:
        'Full-text search over this project: its pages and its task states at once, returning a snippet per hit instead of whole documents. Use it to find the page or the past task that already answers a question before reading either in full.',
      inputSchema: SEARCH_SCHEMA,
      handler: (args) => guarded(args, (a) => searchKb(kb, a)),
    },
  ];
}
