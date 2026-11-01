import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { vaultListText } from '../src/cli-messages.js';

// Primer uso en Windows: `pa vault list` con la caja fuerte vacía no imprimía
// nada, y parecía que la orden no había hecho nada.
describe('pa vault list con la caja fuerte vacía', () => {
  it('lo dice en castellano; con claves guardadas lista solo los nombres', () => {
    expect(vaultListText([])).toMatch(/^No hay ninguna clave guardada todavía\./);
    expect(vaultListText([])).toContain('pa vault set-stdin');
    expect(vaultListText(['telegram:token', 'provider:apiKey'])).toBe(
      'telegram:token\nprovider:apiKey\n',
    );
  });

  it('a través de la CLI construida', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-vault-list-'));
    const env = {
      ...process.env,
      PA_STATE_DIR: dir,
      PA_VAULT_BACKEND: 'portable',
      PA_SECRETS_FILE: join(dir, 'secrets.json'),
    };
    const pa = (args: string[], input = '') =>
      spawnSync(process.execPath, [resolve('dist/cli.js'), 'vault', ...args], {
        encoding: 'utf8',
        input,
        timeout: 60_000,
        env,
      });
    try {
      const vacia = pa(['list']);
      expect(vacia.status, vacia.stderr).toBe(0);
      expect(vacia.stdout).toMatch(/No hay ninguna clave guardada todavía/);
      expect(pa(['set-stdin', 'demo:clave'], 'valor-falso\n').status).toBe(0);
      const llena = pa(['list']);
      expect(llena.stdout).toBe('demo:clave\n');
      expect(llena.stdout).not.toContain('valor-falso');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
