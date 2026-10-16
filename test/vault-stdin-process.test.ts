import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('stores synthetic stdin through the actual built CLI without exposing the value in stdout/stderr', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-vault-stdin-'));
  const env = {
    ...process.env,
    PA_STATE_DIR: dir,
    PA_VAULT_BACKEND: 'portable',
    PA_SECRETS_FILE: join(dir, 'secrets.json'),
  };
  try {
    const result = spawnSync(
      process.execPath,
      [resolve('dist/cli.js'), 'vault', 'set-stdin', 'synthetic:key'],
      { encoding: 'utf8', input: 'synthetic-private-value\n', timeout: 15000, env },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout + result.stderr).not.toContain('synthetic-private-value');
    expect(JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8'))['synthetic:key']).toBe(
      'synthetic-private-value',
    );
    if (process.platform !== 'win32')
      expect(statSync(join(dir, 'secrets.json')).mode & 0o077).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it('prints neither secret input nor backend exception content on invalid secret', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-vault-stdin-bad-'));
  try {
    const result = spawnSync(
      process.execPath,
      [resolve('dist/cli.js'), 'vault', 'set-stdin', 'synthetic:key'],
      {
        encoding: 'utf8',
        input: 'synthetic-private-value\nsecond-line',
        timeout: 15000,
        env: { ...process.env, PA_STATE_DIR: dir },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain('synthetic-private-value');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
