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

  it('reports the entries a confirmed rewrite dropped and keeps their text in the history', async () => {
    const task = await store.start('Ship it');
    await store.patch({ decisions: ['used stdio', 'kept the legacy root'] }, task.meta.id);

    const report: PatchReport = {};
    await store.patch({ decisions: ['kept the legacy root'] }, task.meta.id, report, ['decisions']);

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
    await store.patch({ decisions: [] }, task.meta.id, report, ['decisions']);

    expect(report.dropped).toEqual({ was: 1, now: 0, entries: ['scope cut to the adapter'] });
  });
});

/**
 * The refusal that replaced the note-after-the-fact for the wholesale case.
 *
 * A note could only report a loss that had already landed, and reporting it did not stop it: the
 * session of 27.09.2026 sent a bare `decisions` key five times with the rule printed in every
 * prompt. What is refused is the key that means "append one" being used to send the whole array;
 * a path key that names one entry is precise and stays allowed.
 */
describe('TaskStore refusing a wholesale key that shortens a log', () => {
  let dir: string;
  let store: TaskStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'state3-logrefusal-'));
    store = new TaskStore(dir);
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses the patch, leaves Σ as it was, and records the refusal', async () => {
    const task = await store.start('Ship it');
    await store.patch({ decisions: ['used stdio', 'kept the legacy root'] }, task.meta.id);

    await expect(
      store.patch({ decisions: ['kept the legacy root'] }, task.meta.id),
    ).rejects.toThrow(/"decisions" is append-only/);

    const after = await store.show(task.meta.id);
    expect(after.state.decisions).toEqual(['used stdio', 'kept the legacy root']);
    expect((await store.history(task.meta.id)).at(-1)?.ok).toBe(false);
  });

  it('names the two ways out: a path key, or saying the rewrite is meant', async () => {
    const task = await store.start('Ship it');
    await store.patch({ decisions: ['used stdio', 'kept the legacy root'] }, task.meta.id);

    const refusal = await store
      .patch({ decisions: ['kept the legacy root'] }, task.meta.id)
      .then(() => null)
      .catch((err: unknown) => (err instanceof Error ? err.message : String(err)));

    expect(refusal).toContain('{"decisions[+]":…}');
    expect(refusal).toContain('{"decisions[3]":null}');
    expect(refusal).toContain('confirm: ["decisions"]');
    expect(refusal).toContain('"used stdio"');
  });

  it('refuses a wholesale key that would shorten the verifications log', async () => {
    const task = await store.start('Ship it');
    await store.patch(
      {
        verifications: [
          { check: 'npm test', status: 'pass' },
          { check: 'npm run lint', status: 'pass' },
        ],
      },
      task.meta.id,
    );

    await expect(
      store.patch({ verifications: [{ check: 'npm test', status: 'pass' }] }, task.meta.id),
    ).rejects.toThrow(/"verifications" is append-only/);
  });

  it('leaves a reworded verification alone, which the stamp note already reports', async () => {
    const task = await store.start('Ship it');
    await store.patch({ verifications: [{ check: 'npm test', status: 'pass' }] }, task.meta.id);

    // Same length, different text: a legitimate correction, not an accident, and refusing it
    // would refuse the work the stamps exist to keep honest.
    const report: PatchReport = {};
    await store.patch(
      { verifications: [{ check: 'npm test -- --run', status: 'pass' }] },
      task.meta.id,
      report,
    );

    expect(report.stamps?.superseded.length).toBe(1);
  });

  it('refuses a confirm that names something which is not a log', async () => {
    const task = await store.start('Ship it');
    await store.patch({ decisions: ['used stdio'] }, task.meta.id);

    await expect(
      store.patch({ 'decisions[0]': null }, task.meta.id, undefined, ['plan']),
    ).rejects.toThrow(/the append-only logs are: decisions, verifications/);
  });
});
