import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { vaultEmptyValueText } from '../src/cli-messages.js';

// «pa vault set telegram:botToken "%TOKEN%"» con la variable sin definir llegaba con
// el valor vacío: se guardaba una clave vacía y contestaba «Guardado». set-stdin ya
// rechaza un valor vacío, pero lo hacía soltando antes una línea JSON del registro en
// la consola.
function vault() {
  const dir = mkdtempSync(join(tmpdir(), 'pa-testeo2-vacio-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PA_STATE_DIR: dir,
    PA_VAULT_BACKEND: 'portable',
    PA_SECRETS_FILE: join(dir, 'secrets.json'),
    NO_COLOR: '1',
  };
  delete env.FORCE_COLOR;
  const pa = (input: string, ...args: string[]) =>
    spawnSync(process.execPath, [resolve('dist/cli.js'), 'vault', ...args], {
      encoding: 'utf8',
      input,
      timeout: 60_000,
      env,
    });
  return { pa, done: () => rmSync(dir, { recursive: true, force: true }) };
}

it('pa vault set con el valor vacío no guarda nada y lo dice', () => {
  const { pa, done } = vault();
  try {
    for (const value of ['', '   ']) {
      const r = pa('', 'set', 'telegram:botToken', value);
      expect(r.status).toBe(2);
      expect(r.stdout).toBe('');
      expect(r.stderr).toBe(vaultEmptyValueText());
      expect(pa('', 'get', 'telegram:botToken').status).toBe(1);
    }
  } finally {
    done();
  }
}, 120_000);

it('pa vault set-stdin sin valor avisa sin soltar JSON del registro en la consola', () => {
  const { pa, done } = vault();
  try {
    const r = pa('', 'set-stdin', 'telegram:botToken');
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('Se requiere un secreto no vacío');
    expect(r.stderr).not.toContain('{"');
  } finally {
    done();
  }
}, 120_000);
