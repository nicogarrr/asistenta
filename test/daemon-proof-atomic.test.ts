import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it as baseIt, expect, vi } from 'vitest';

const observation = vi.hoisted(() => ({ beforeWrite: false, afterWrite: false, tested: false }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      const file = String(args[0]);
      if (file.endsWith('.stopped.tmp')) {
        observation.tested = true;
        observation.beforeWrite = fs.existsSync(file.slice(0, -4));
        fs.writeFileSync(...args);
        observation.afterWrite = fs.existsSync(file.slice(0, -4));
      } else fs.writeFileSync(...args);
    },
  };
});

import { openDaemonControl } from '../src/daemon-control.js';

const it = process.platform === 'linux' ? baseIt : baseIt.skip;
it('publishes final stopped proof only by atomic rename after a complete private temporary write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-proof-'));
  const control = await openDaemonControl(dir, () => {});
  try {
    control.ready();
    await control.close(true);
    expect(observation.tested).toBe(true);
    expect(observation.beforeWrite).toBe(false);
    expect(observation.afterWrite).toBe(false);
    const final = join(dir, 'control', `${control.instanceId}.stopped`);
    expect(JSON.parse(readFileSync(final, 'utf8')).clean).toBe(true);
    expect(existsSync(`${final}.tmp`)).toBe(false);
  } finally {
    await control.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
