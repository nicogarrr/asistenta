import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { vaultUsageText } from '../src/cli-messages.js';

// `pa vault` sin nada o con una palabra mal escrita soltaba la ayuda entera de
// `pa` (decenas de líneas). Ahora: qué no entendió y las órdenes de la caja fuerte.
it('pa vault sin orden o con una orden mal escrita da una ayuda corta en castellano', () => {
  expect(vaultUsageText()).toMatch(/^Órdenes de la caja fuerte:/);
  expect(vaultUsageText('lsit')).toMatch(/^No conozco «lsit» en pa vault\.\n/);
  const dir = mkdtempSync(join(tmpdir(), 'pa-vault-uso-'));
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
    for (const [args, inicio] of [
      [[], 'Órdenes de la caja fuerte:'],
      [['lsit'], 'No conozco «lsit» en pa vault.'],
    ] as const) {
      const r = pa(...args);
      expect(r.status).toBe(2);
      expect(r.stderr.startsWith(inicio), r.stderr).toBe(true);
      expect(r.stderr).toContain('pa vault set-stdin <nombre>');
      expect(r.stderr).toContain('pa vault list');
      expect(r.stderr.split('\n').length).toBeLessThan(12);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
