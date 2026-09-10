import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatRuntimeInfo, runtimeInfo } from '../src/runtime-info.js';

describe('runtimeInfo', () => {
  it('reports the package version and where the code was loaded from', async () => {
    const info = await runtimeInfo();
    const pkg = JSON.parse(await readFile(resolve('package.json'), 'utf-8')) as { version: string };

    expect(info.version).toBe(pkg.version);
    expect(info.loadedFrom).toMatch(/(dist|src)$/);
    // Under vitest the sources are what runs, so a stale build is never reported.
    expect(info.staleBuild).toBe(false);
  });

  it('never throws when the package manifest cannot be read', async () => {
    const info = await runtimeInfo();
    expect(typeof info.version).toBe('string');
    expect(info.version.length).toBeGreaterThan(0);
  });
});

describe('formatRuntimeInfo', () => {
  it('prints one line naming the version and the build', () => {
    const fresh = { version: '1.2.3', loadedFrom: '/app/dist', staleBuild: false };
    expect(formatRuntimeInfo(fresh)).toBe('runtime: skillstate 1.2.3 (/app/dist)');
  });

  it('warns when the sources are newer than the build answering', () => {
    const stale = { version: '1.2.3', loadedFrom: '/app/dist', staleBuild: true };
    const line = formatRuntimeInfo(stale);
    expect(line).toContain('runtime: skillstate 1.2.3');
    expect(line).toContain('STALE');
    expect(line).toContain('rebuild');
  });
});
