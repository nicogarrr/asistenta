import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

// Primer uso en Windows: los pasos de la guía (`pa vault set …`, `pa vault rm …`)
// respondían en inglés («stored», «no such secret», «usage: …»).
it('pa vault set/get/rm responden en castellano', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-vault-es-'));
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
    const set = pa('set', 'mailRead:address', 'demo@example.test');
    expect(set.status, set.stderr).toBe(0);
    expect(set.stdout).toBe('Guardado: mailRead:address\n');
    const sinValor = pa('set', 'mailRead:address');
    expect(sinValor.status).toBe(2);
    expect(sinValor.stderr).toMatch(/^Uso: pa vault set <nombre> <valor>/);
    expect(sinValor.stderr).toContain('pa vault set-stdin');
    expect(pa('get').stderr).toBe('Uso: pa vault get <nombre>\n');
    const falta = pa('get', 'noExiste');
    expect(falta.status).toBe(1);
    expect(falta.stderr).toBe(
      'No hay ninguna clave guardada con el nombre «noExiste». Para verlas: pa vault list\n',
    );
    expect(pa('rm').stderr).toBe('Uso: pa vault rm <nombre>\n');
    expect(pa('rm', 'mailRead:address').stdout).toBe('Borrado: mailRead:address\n');
    expect(pa('rm', 'mailRead:address').stdout).toMatch(/^No hay ninguna clave guardada/);
    const todo = [set, sinValor, falta].map((r) => r.stdout + r.stderr).join('');
    expect(todo).not.toMatch(/stored|no such secret|usage:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 180_000);
