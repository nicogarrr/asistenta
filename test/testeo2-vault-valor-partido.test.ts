import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { vaultSplitValueText } from '../src/cli-messages.js';

// La contraseña de aplicación de Gmail se enseña en 4 grupos («abcd efgh ijkl mnop»).
// Pegada sin comillas tras «pa vault set», llegaba en trozos y se guardaba solo «abcd».
it('pa vault set con un valor partido en trozos no guarda nada y lo dice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-testeo2-vault-'));
  const env = {
    ...process.env,
    PA_STATE_DIR: dir,
    PA_VAULT_BACKEND: 'portable',
    PA_SECRETS_FILE: join(dir, 'secrets.json'),
  };
  const pa = (...args: string[]) =>
    spawnSync(process.execPath, [resolve('dist/cli.js'), 'vault', ...args], {
      encoding: 'utf8',
      input: '',
      timeout: 60_000,
      env,
    });
  try {
    const split = pa('set', 'mailRead:password', 'abcd', 'efgh', 'ijkl', 'mnop');
    expect(split.status).toBe(2);
    expect(split.stdout).toBe('');
    expect(split.stderr).toBe(vaultSplitValueText(4));
    expect(split.stderr).toContain('pa vault set-stdin');
    expect(split.stderr).not.toContain('abcd');
    expect(pa('get', 'mailRead:password').status).toBe(1);

    const quoted = pa('set', 'mailRead:password', 'abcd efgh ijkl mnop');
    expect(quoted.status, quoted.stderr).toBe(0);
    expect(pa('get', 'mailRead:password').stdout).toBe('abcd efgh ijkl mnop\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
