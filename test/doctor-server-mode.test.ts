import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it.skipIf(process.platform !== 'linux')(
  'built doctor in server mode skips Windows desktop checks',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-doctor-'));
    try {
      const result = spawnSync(process.execPath, [resolve('dist/cli.js'), 'doctor'], {
        encoding: 'utf8',
        timeout: 20000,
        env: { ...process.env, PA_STATE_DIR: dir, PA_DESKTOP: 'off' },
      });
      const out = result.stdout + result.stderr;
      expect(result.status).toBe(0);
      expect(out).toContain('modo servidor');
      expect(out).not.toContain('powershell.exe');
      expect(out).not.toContain('screenshot      ');
      expect(out).not.toContain('MISSING (/camera');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
