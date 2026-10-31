// FIRST import statement, always - before ANYTHING that transitively loads
// paths.ts: it assigns PA_STATE_DIR (fresh mkdtemp per run) before paths.ts
// can snapshot the real state dir.
// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que vault.js cargue paths.ts
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { paths } from '../src/paths.js';
import { clearVaultCache, parseDpapiVaultFile, vaultGet } from '../src/vault.js';

// robustez-10: un vault.json dañado (modo DPAPI de Windows) ya no suelta el
// SyntaxError en inglés ni «unsupported vault version» al chat.
const prevBackend = process.env.PA_VAULT_BACKEND;
afterEach(() => {
  rmSync(paths.vault, { force: true });
  clearVaultCache();
  if (prevBackend === undefined) delete process.env.PA_VAULT_BACKEND;
  else process.env.PA_VAULT_BACKEND = prevBackend;
});

async function errorOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return '(no error)';
}

describe('vault.json dañado en modo DPAPI', () => {
  it('el estado del test está aislado', () => {
    expect(paths.vault.startsWith(FACTORY_TEST_STATE_DIR)).toBe(true);
  });

  it('un archivo a medias da una frase clara, sin el error del parser ni su contenido', async () => {
    process.env.PA_VAULT_BACKEND = 'dpapi';
    mkdirSync(dirname(paths.vault), { recursive: true });
    writeFileSync(paths.vault, '{"version":1,"wrappedDek":"QUJD');
    const msg = await errorOf(vaultGet('anthropic'));
    expect(msg).toContain('caja fuerte de claves');
    expect(msg).toContain('dañada');
    expect(msg).not.toMatch(/JSON|Unexpected|Unterminated|QUJD|position/);
  });

  it('una versión desconocida no sale en inglés', async () => {
    process.env.PA_VAULT_BACKEND = 'dpapi';
    mkdirSync(dirname(paths.vault), { recursive: true });
    writeFileSync(paths.vault, JSON.stringify({ version: 2, wrappedDek: 'x', ciphertext: 'y' }));
    const msg = await errorOf(vaultGet('anthropic'));
    expect(msg).toContain('Asistenta más nueva');
    expect(msg).not.toMatch(/unsupported|version 2/);
  });

  it('parseDpapiVaultFile: vacío, null, sin campos o con BOM', () => {
    expect(() => parseDpapiVaultFile('')).toThrow(/dañada/);
    expect(() => parseDpapiVaultFile('null')).toThrow(/dañada/);
    expect(() => parseDpapiVaultFile('{"version":1}')).toThrow(/dañada/);
    expect(() => parseDpapiVaultFile('{"version":"1","wrappedDek":"a","ciphertext":"b"}')).toThrow(
      /dañada/,
    );
    const ok = parseDpapiVaultFile('\uFEFF{"version":1,"wrappedDek":"a","ciphertext":"b"}');
    expect(ok.wrappedDek).toBe('a');
  });
});
