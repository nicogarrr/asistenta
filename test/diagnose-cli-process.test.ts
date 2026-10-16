import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

// Compiled CLI imports the desktop stack. Run in the resource phase rather than
// competing with eight browser/Office workers; the 15-second limit is unchanged.
it('routes the built CLI without provider keys or Telegram token', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-diagnose-process-'));
  try {
    const result = spawnSync(process.execPath, [resolve('dist/cli.js'), 'diagnose', '--json'], {
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        PA_STATE_DIR: dir,
        PA_DESKTOP: 'off',
        PA_PROVIDER_API_KEY: '',
        TELEGRAM_BOT_TOKEN: '',
      },
    });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.state.pid).toBe(null);
    expect(report.actions.file).toBe(join(dir, 'actions.jsonl'));
    expect(readdirSync(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
