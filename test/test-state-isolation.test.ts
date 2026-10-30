import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { paths, STATE_DIR } from '../src/paths.js';

// La suite no puede tocar el estado real del agente (perfiles del navegador,
// grants.json, vault, base de datos, logs) de quien ejecuta `npm test`.
describe('aislamiento del estado en los tests', () => {
  it('PA_STATE_DIR apunta a un directorio temporal de la ejecución', () => {
    const dir = process.env.PA_STATE_DIR;
    expect(dir).toBeTruthy();
    expect(resolve(dir ?? '')).toContain(resolve(tmpdir(), '..'));
    expect(dir).toMatch(/pa-test-state-/);
  });

  it('tmpdir() es un directorio propio de la ejecución (se borra entero al terminar)', () => {
    const dir = tmpdir();
    expect(dir).toMatch(/pa-test-tmp-/);
    expect(process.env.PA_TEST_TMP_DIR).toBe(dir);
    // Windows lee TEMP/TMP; los procesos hijos heredan los tres.
    expect(process.env.TEMP).toBe(dir);
    expect(process.env.TMP).toBe(dir);
  });

  it('paths.ts no resuelve al estado real de ~/.local/share/personal-agent', () => {
    const real = join(homedir(), '.local', 'share', 'personal-agent');
    expect(STATE_DIR).not.toBe(real);
    expect(paths.vault.startsWith(real)).toBe(false);
    expect(paths.db.startsWith(real)).toBe(false);
  });
});
