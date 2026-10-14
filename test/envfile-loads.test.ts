import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

/**
 * El contrato del bootstrap: .env se aplica ANTES de que se evaluen los
 * modulos que capturan process.env a nivel de modulo (paths.ts: PA_STATE_DIR,
 * log.ts: PA_LOG_LEVEL). Por eso este archivo NO importa estaticamente nada
 * de src/: todo entra por import() dinamico despues de cargar envfile.
 */
const dir = mkdtempSync(join(tmpdir(), 'envfile-loads-'));
const stateDir = join(dir, 'estado');
const prevCwd = process.cwd();
const prev = process.env.PA_STATE_DIR;

beforeAll(() => {
  writeFileSync(join(dir, '.env'), `PA_STATE_DIR=${stateDir}\n`);
  delete process.env.PA_STATE_DIR;
  process.chdir(dir);
});

afterAll(() => {
  process.chdir(prevCwd);
  if (prev === undefined) {
    delete process.env.PA_STATE_DIR;
  } else {
    process.env.PA_STATE_DIR = prev;
  }
  rmSync(dir, { recursive: true, force: true });
});

it('PA_STATE_DIR del .env llega a paths.ts (orden del bootstrap)', async () => {
  await import('../src/envfile.js');
  expect(process.env.PA_STATE_DIR).toBe(stateDir);
  const paths = await import('../src/paths.js');
  expect(paths.STATE_DIR).toBe(stateDir);
});
