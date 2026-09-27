import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatRuntimeInfo, rebuiltAfterStart, runtimeInfo } from '../src/runtime-info.js';

const REBUILT = '2026-09-26T12:30:00.000Z';

describe('runtimeInfo', () => {
  it('reports the package version and where the code was loaded from', async () => {
    const info = await runtimeInfo();
    const pkg = JSON.parse(await readFile(resolve('package.json'), 'utf-8')) as { version: string };

    expect(info.version).toBe(pkg.version);
    expect(info.loadedFrom).toMatch(/(dist|src)$/);
    // Under vitest the sources are what runs, so neither staleness is reported: both are facts
    // about a `dist` build, and a test process is not a host holding a server it started.
    expect(info.staleBuild).toBe(false);
    expect(info.rebuiltAt).toBe(null);
  });

  it('never throws when the package manifest cannot be read', async () => {
    const info = await runtimeInfo();
    expect(typeof info.version).toBe('string');
    expect(info.version.length).toBeGreaterThan(0);
  });
});

describe('rebuiltAfterStart', () => {
  const startedAt = Date.parse('2026-09-26T10:00:00.000Z');

  it('names the moment the build on disk replaced the one this process loaded', () => {
    expect(rebuiltAfterStart(startedAt, Date.parse(REBUILT))).toBe(REBUILT);
  });

  it('stays silent while the process runs the newest build there is', () => {
    expect(rebuiltAfterStart(startedAt, startedAt - 1)).toBe(null);
    // The same millisecond is the build this process loaded, not one written after it.
    expect(rebuiltAfterStart(startedAt, startedAt)).toBe(null);
  });

  it('stays silent when there is no build on disk to compare against', () => {
    expect(rebuiltAfterStart(startedAt, null)).toBe(null);
  });
});

describe('formatRuntimeInfo', () => {
  const fresh = { version: '1.2.3', loadedFrom: '/app/dist', staleBuild: false, rebuiltAt: null };

  it('prints one line naming the version and the build', () => {
    expect(formatRuntimeInfo(fresh)).toBe('runtime: state3 1.2.3 (/app/dist)');
  });

  it('warns when the sources are newer than the build answering', () => {
    const line = formatRuntimeInfo({ ...fresh, staleBuild: true });
    expect(line).toContain('runtime: state3 1.2.3');
    expect(line).toContain('STALE');
    expect(line).toContain('rebuild');
  });

  it('warns when the build was replaced under the process answering, and says since when', () => {
    const line = formatRuntimeInfo({ ...fresh, rebuiltAt: REBUILT });
    expect(line).toContain('RESTART');
    expect(line).toContain(REBUILT);
    expect(line).toContain('restart the host');
    expect(line).not.toContain('STALE');
  });

  it('keeps one warning when both hold: the rebuild it asks for ends in a restart', () => {
    const line = formatRuntimeInfo({ ...fresh, staleBuild: true, rebuiltAt: REBUILT });
    expect(line).toContain('STALE');
    expect(line).not.toContain('RESTART');
  });
});
