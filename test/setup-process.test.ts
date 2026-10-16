import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('built setup refuses non-TTY without consuming a pasted secret or opening vault/control', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-setup-nontty-'));
  try {
    const result = spawnSync(process.execPath, [resolve('dist/cli.js'), 'setup'], {
      encoding: 'utf8',
      input: 'synthetic-do-not-print\n',
      timeout: 15000,
      env: { ...process.env, PA_STATE_DIR: dir, PA_DESKTOP: 'off' },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('terminal local interactiva');
    expect(result.stdout + result.stderr).not.toContain('synthetic-do-not-print');
    expect(readdirSync(dir).filter((n) => n !== 'log')).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it('built setup rejects arguments without echoing them or creating state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-setup-args-'));
  try {
    const result = spawnSync(
      process.execPath,
      [resolve('dist/cli.js'), 'setup', 'synthetic-do-not-print'],
      {
        encoding: 'utf8',
        timeout: 15000,
        env: { ...process.env, PA_STATE_DIR: dir, PA_DESKTOP: 'off' },
      },
    );
    expect(result.status).toBe(2);
    expect(result.stdout + result.stderr).not.toContain('synthetic-do-not-print');
    expect(readdirSync(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
