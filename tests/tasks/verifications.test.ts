import { describe, expect, it } from 'vitest';
import type { StateDict } from '../../src/core/types.js';
import { stampVerifications } from '../../src/tasks/verifications.js';

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
});
