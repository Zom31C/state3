import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StateDict } from '../../src/core/types.js';
import {
  decisionsHistoryNote,
  decisionsWarnings,
  droppedDecisions,
} from '../../src/tasks/decisions.js';
import { TaskStore } from '../../src/tasks/store.js';
import type { PatchReport } from '../../src/tasks/store.js';

/** A Σ whose only interesting field is the log; the rest of a state is the schema's business. */
function logged(entries: readonly string[]): StateDict {
  return { goal: 'g', status: 'active', decisions: [...entries] } as unknown as StateDict;
}

describe('droppedDecisions', () => {
  it('is silent about an append, a resend and a reorder', () => {
    expect(droppedDecisions(logged(['a']), logged(['a', 'b']))).toBeNull();
    expect(droppedDecisions(logged(['a', 'b']), logged(['a', 'b']))).toBeNull();
    expect(droppedDecisions(logged(['a', 'b']), logged(['b', 'a']))).toBeNull();
  });

  it('names the entries a shorter array dropped, in the order the log held them', () => {
    expect(droppedDecisions(logged(['a', 'b', 'c']), logged(['b']))).toEqual({
      was: 3,
      now: 1,
      entries: ['a', 'c'],
    });
  });

  it('counts a reworded entry as dropped, because the text that was there is gone either way', () => {
    const dropped = droppedDecisions(logged(['used stdio']), logged(['used the stdio transport']));

    expect(dropped).toEqual({ was: 1, now: 1, entries: ['used stdio'] });
  });

  it('says nothing about a state that keeps no such log', () => {
    expect(droppedDecisions({ goal: 'g' } as StateDict, { goal: 'g' } as StateDict)).toBeNull();
  });
});

describe('how the loss is reported', () => {
  it('keeps the whole text in the audit line and quotes part of it in the answer', () => {
    const long = 'x'.repeat(120);
    const dropped = { was: 1, now: 0, entries: [long] };

    expect(decisionsHistoryNote(dropped)).toBe(`1 decisions entry(s) left Σ (1 -> 0): "${long}"`);

    const warning = decisionsWarnings(dropped)[0] ?? '';
    expect(warning).toContain('1 decisions entry(s) are no longer in Σ (1 -> 0)');
    expect(warning).toContain(`${'x'.repeat(80)}…`);
    expect(warning).not.toContain(long);
    expect(warning).toContain('task_history keeps this line');
  });

  it('counts the entries it does not list, and reports nothing when nothing was dropped', () => {
    const dropped = { was: 7, now: 0, entries: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] };

    expect(decisionsWarnings(dropped)[0]).toContain('and 2 more');
    expect(decisionsWarnings(null)).toEqual([]);
    expect(decisionsHistoryNote(null)).toBeNull();
  });
});

describe('TaskStore reporting a shortened log', () => {
  let dir: string;
  let store: TaskStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'state3-decisions-'));
    store = new TaskStore(dir);
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('reports the entries a patch dropped and keeps their text in the history', async () => {
    const task = await store.start('Ship it');
    await store.patch({ decisions: ['used stdio', 'kept the legacy root'] }, task.meta.id);

    const report: PatchReport = {};
    await store.patch({ decisions: ['kept the legacy root'] }, task.meta.id, report);

    expect(report.dropped).toEqual({ was: 2, now: 1, entries: ['used stdio'] });
    const entries = await store.history(task.meta.id);
    expect(entries.at(-1)?.note).toBe('1 decisions entry(s) left Σ (2 -> 1): "used stdio"');
  });

  it('is silent about a patch that only appended', async () => {
    const task = await store.start('Ship it');
    await store.patch({ decisions: ['used stdio'] }, task.meta.id);

    const report: PatchReport = {};
    await store.patch(
      { decisions: ['used stdio', 'and the single database'] },
      task.meta.id,
      report,
    );

    expect(report.dropped).toBeUndefined();
    expect((await store.history(task.meta.id)).at(-1)?.note).toBeUndefined();
  });

  it('reports an entry removed by a path key, which is a wholesale replacement underneath', async () => {
    const task = await store.start('Ship it');
    await store.patch({ decisions: ['used stdio', 'kept the legacy root'] }, task.meta.id);

    const report: PatchReport = {};
    await store.patch({ 'decisions[0]': null }, task.meta.id, report);

    expect(report.dropped?.entries).toEqual(['used stdio']);
  });

  it('reports the log of a supervising task too, whose Σ carries the same field', async () => {
    const task = await store.start('Review the worker', { skill: 'supervise-task' });
    await store.patch({ decisions: ['scope cut to the adapter'] }, task.meta.id);

    const report: PatchReport = {};
    await store.patch({ decisions: [] }, task.meta.id, report);

    expect(report.dropped).toEqual({ was: 1, now: 0, entries: ['scope cut to the adapter'] });
  });
});
