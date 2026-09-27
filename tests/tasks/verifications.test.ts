import { describe, expect, it } from 'vitest';
import type { StateDict } from '../../src/core/types.js';
import {
  stampHistoryNote,
  stampVerifications,
  stampWarnings,
} from '../../src/tasks/verifications.js';
import type { StampReport, SupersededStamp } from '../../src/tasks/verifications.js';

const NOW = '2026-09-18T22:00:00.000Z';
const HEAD = 'abc1234';

function state(verifications: unknown): StateDict {
  return { goal: 'g', status: 'active', verifications } as unknown as StateDict;
}

/** A stamp provider that counts its calls: reading git is a subprocess, and it must be lazy. */
function counter(): { calls: number; stamp: () => { at: string; commit: string | null } } {
  const provider = {
    calls: 0,
    stamp: () => {
      provider.calls += 1;
      return { at: NOW, commit: HEAD };
    },
  };
  return provider;
}

describe('stampVerifications', () => {
  it('stamps an entry the patch added, with the time and the commit', () => {
    const merged = state([{ check: 'npm test', status: 'pass' }]);

    stampVerifications(state([]), merged, counter().stamp);

    expect(merged.verifications).toEqual([
      { check: 'npm test', status: 'pass', at: NOW, commit: HEAD },
    ]);
  });

  it('leaves an unchanged entry with the stamp it already had', () => {
    const recorded = {
      check: 'npm test',
      status: 'pass',
      at: '2026-09-01T10:00:00.000Z',
      commit: 'old0000',
    };
    const merged = state([{ ...recorded }]);

    stampVerifications(state([recorded]), merged, counter().stamp);

    expect(merged.verifications).toEqual([recorded]);
  });

  it('re-stamps an entry whose result changed, which is the point of the stamp', () => {
    const before = {
      check: 'dev.bat check',
      status: 'fail',
      at: '2026-09-01T10:00:00.000Z',
      commit: 'old0000',
    };
    const merged = state([
      { check: 'dev.bat check', status: 'pass', at: before.at, commit: before.commit },
    ]);

    stampVerifications(state([before]), merged, counter().stamp);

    expect(merged.verifications).toEqual([
      { check: 'dev.bat check', status: 'pass', at: NOW, commit: HEAD },
    ]);
  });

  it('never asks for a stamp when no entry changed, so a plain patch spawns no subprocess', () => {
    const recorded = { check: 'npm test', status: 'pass', at: NOW, commit: HEAD };
    const provider = counter();

    stampVerifications(state([recorded]), state([{ ...recorded }]), provider.stamp);

    expect(provider.calls).toBe(0);
  });

  it('keeps an entry written before stamps existed unstamped instead of claiming it is new', () => {
    const legacy = { check: 'npm test', status: 'pass' };
    const provider = counter();

    const merged = state([{ ...legacy }]);
    stampVerifications(state([legacy]), merged, provider.stamp);

    expect(merged.verifications).toEqual([legacy]);
    expect(provider.calls).toBe(0);
  });

  it('matches by content, so removing an entry does not re-stamp the ones after it', () => {
    const kept = {
      check: 'npm test',
      status: 'pass',
      at: '2026-09-01T10:00:00.000Z',
      commit: 'old0000',
    };
    const dropped = {
      check: 'old check',
      status: 'fail',
      at: '2026-09-01T10:00:00.000Z',
      commit: 'old0000',
    };
    const provider = counter();

    const merged = state([{ ...kept }]);
    stampVerifications(state([dropped, kept]), merged, provider.stamp);

    // `kept` moved from index 1 to index 0 and is still the entry that was recorded then.
    expect(merged.verifications).toEqual([kept]);
    expect(provider.calls).toBe(0);
  });

  it('records a null commit outside a repository rather than leaving the field out', () => {
    const merged = state([{ check: 'npm test', status: 'pass' }]);

    stampVerifications(state([]), merged, () => ({ at: NOW, commit: null }));

    expect(merged.verifications).toEqual([
      { check: 'npm test', status: 'pass', at: NOW, commit: null },
    ]);
  });

  it('is a no-op for a skill whose Σ has no verifications', () => {
    const merged = { goal: 'g', rounds: [] } as unknown as StateDict;
    const provider = counter();

    stampVerifications(merged, merged, provider.stamp);

    expect(merged).toEqual({ goal: 'g', rounds: [] });
    expect(provider.calls).toBe(0);
  });

  it('keeps the stamp of an entry whose fields were sent in another order', () => {
    const recorded = {
      check: 'npm test',
      status: 'pass',
      at: '2026-09-01T10:00:00.000Z',
      commit: 'old0000',
    };
    const provider = counter();

    // The order an agent types the fields in is not part of what it recorded, so a resend
    // that reorders them is the same entry and must not be stamped again.
    const merged = state([{ status: 'pass', check: 'npm test' }]);
    const report = stampVerifications(state([recorded]), merged, provider.stamp);

    expect(merged.verifications).toEqual([recorded]);
    expect(provider.calls).toBe(0);
    expect(report).toEqual({ carried: 1, stamped: 0, superseded: [] });
  });

  it('keeps the stamp of an entry whose nested fields were sent in another order', () => {
    const recorded = {
      check: 'npm test',
      status: 'pass',
      detail: { lines: 12, runner: 'vitest' },
      at: '2026-09-01T10:00:00.000Z',
      commit: 'old0000',
    };
    const provider = counter();

    const merged = state([
      { status: 'pass', detail: { runner: 'vitest', lines: 12 }, check: 'npm test' },
    ]);
    stampVerifications(state([recorded]), merged, provider.stamp);

    expect(merged.verifications).toEqual([recorded]);
    expect(provider.calls).toBe(0);
  });

  it('reports the stamp a reworded entry lost, with the check it belonged to', () => {
    const recorded = {
      check: 'dev.bat check -> ALL CHECKS PASSED on the full suite',
      status: 'pass',
      at: '2026-09-19T21:54:18.959Z',
      commit: 'ea6f494',
    };

    const merged = state([{ check: 'dev.bat check ALL PASSED', status: 'pass' }]);
    const report = stampVerifications(state([recorded]), merged, counter().stamp);

    expect(report.carried).toBe(0);
    expect(report.stamped).toBe(1);
    expect(report.superseded).toEqual([
      {
        check: recorded.check,
        at: recorded.at,
        commit: recorded.commit,
      },
    ]);
  });

  it('reports the stamp of an entry the patch dropped, which is the same loss', () => {
    const kept = { check: 'npm test', status: 'pass', at: NOW, commit: HEAD };
    const dropped = {
      check: 'obsolete probe',
      status: 'fail',
      at: '2026-09-01T10:00:00.000Z',
      commit: 'old0000',
    };

    const report = stampVerifications(
      state([kept, dropped]),
      state([{ ...kept }]),
      counter().stamp,
    );

    expect(report).toEqual({
      carried: 1,
      stamped: 0,
      superseded: [{ check: 'obsolete probe', at: dropped.at, commit: 'old0000' }],
    });
  });

  it('does not report an entry that never had a stamp to lose', () => {
    const legacy = { check: 'npm test', status: 'pass' };

    const report = stampVerifications(
      state([legacy]),
      state([{ check: 'npm test shortened', status: 'pass' }]),
      counter().stamp,
    );

    expect(report.superseded).toEqual([]);
    expect(report.stamped).toBe(1);
  });

  it('reads a stamp with no commit as a null commit rather than dropping it', () => {
    const recorded = { check: 'npm test', status: 'pass', at: '2026-09-01T10:00:00.000Z' };

    const report = stampVerifications(
      state([recorded]),
      state([{ check: 'npm test reworded', status: 'pass' }]),
      counter().stamp,
    );

    expect(report.superseded).toEqual([
      { check: 'npm test', at: '2026-09-01T10:00:00.000Z', commit: null },
    ]);
  });
});

describe('stampWarnings', () => {
  const report = (superseded: SupersededStamp[]): StampReport => ({
    carried: 0,
    stamped: superseded.length,
    superseded,
  });

  it('says nothing when no stamp was replaced', () => {
    expect(stampWarnings({ carried: 2, stamped: 1, superseded: [] })).toEqual([]);
  });

  it('names the previous stamp, so the value survives in the answer', () => {
    const lines = stampWarnings(
      report([{ check: 'dev.bat check', at: '2026-09-19T21:54:18.959Z', commit: 'ea6f494' }]),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('1 verification stamp(s) are no longer attached');
    expect(lines[0]).toContain('"dev.bat check" was at 2026-09-19T21:54:18.959Z commit ea6f494');
    expect(lines[0]).toContain('task_history keeps this line');
  });

  it('leaves the lesson to P, and keeps the note down to the fact', () => {
    const lines = stampWarnings(report([{ check: 'npm test', at: NOW, commit: HEAD }]));

    expect(lines[0]).toContain('"npm test" was at');
    expect(lines[0]).toContain('task_history keeps this line');
    // What the note used to carry as well: how to keep a stamp next time. That is in P, where it is
    // read once per task instead of once per patch, and repeating it made the note longer than the
    // state it annotated.
    expect(lines[0]).not.toContain('resend it with the field values');
    expect(lines[0]).not.toContain('A stamp says which tree a check ran on');
    expect((lines[0] ?? '').length).toBeLessThan(300);
  });

  it('names a null commit as null instead of printing nothing', () => {
    const lines = stampWarnings(report([{ check: 'npm test', at: NOW, commit: null }]));

    expect(lines[0]).toContain(`"npm test" was at ${NOW} commit null`);
  });

  it('names the first few superseded stamps and counts the rest', () => {
    const superseded: SupersededStamp[] = Array.from({ length: 7 }, (_, index) => ({
      check: `check ${index}`,
      at: NOW,
      commit: HEAD,
    }));

    const lines = stampWarnings(report(superseded));

    expect(lines[0]).toContain('7 verification stamp(s) are no longer attached');
    expect(lines[0]).toContain('and 2 more');
    expect(lines[0]).toContain('"check 4"');
    expect(lines[0]).not.toContain('"check 5"');
  });

  it('shortens a long check so the note stays readable', () => {
    const lines = stampWarnings(report([{ check: 'x'.repeat(200), at: NOW, commit: HEAD }]));

    expect(lines[0]).toContain(`${'x'.repeat(80)}…`);
    expect(lines[0]).not.toContain('x'.repeat(81));
  });
});

describe('stampHistoryNote', () => {
  it('is null when the patch replaced no stamp', () => {
    expect(stampHistoryNote({ carried: 1, stamped: 0, superseded: [] })).toBeNull();
  });

  it('lists every superseded stamp on the one line the audit trail keeps', () => {
    const note = stampHistoryNote({
      carried: 0,
      stamped: 2,
      superseded: [
        { check: 'npm test', at: NOW, commit: HEAD },
        { check: 'npm run lint', at: '2026-09-01T10:00:00.000Z', commit: null },
      ],
    });

    expect(note).toBe(
      `2 verification stamp(s) superseded: "npm test" was at ${NOW} commit ${HEAD}; ` +
        '"npm run lint" was at 2026-09-01T10:00:00.000Z commit null',
    );
  });
});
