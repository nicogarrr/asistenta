import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Primer arranque sin instalar del todo: cada pieza que falta se explica en
// castellano y lleva al instalador de un paso, nunca a `pa vault set <valor>`.
const state = vi.hoisted(() => ({ path: '', vault: true, secrets: {} as Record<string, string> }));
vi.mock('../src/paths.js', async (original) => ({
  ...(await original<typeof import('../src/paths.js')>()),
  ensureDirs: vi.fn(),
  paths: {
    ...(await original<typeof import('../src/paths.js')>()).paths,
    get state() {
      return state.path;
    },
  },
}));
vi.mock('../src/vault.js', async (original) => ({
  ...(await original<typeof import('../src/vault.js')>()),
  vaultExists: () => state.vault,
  unlock: vi.fn(),
  vaultGet: async (key: string) => state.secrets[key],
}));

import { main } from '../src/cli.js';

state.path = mkdtempSync(join(tmpdir(), 'pa-serve-sin-piezas-'));
afterAll(() => rmSync(state.path, { recursive: true, force: true }));
beforeEach(() => {
  vi.restoreAllMocks();
  state.vault = true;
  state.secrets = {};
});

async function serveText(): Promise<string> {
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  expect(await main(['serve'])).toBe(1);
  return stderr.mock.calls.map(([s]) => String(s)).join('');
}

describe('serve sin instalar: errores claros en castellano', () => {
  it('sin caja fuerte', async () => {
    state.vault = false;
    const text = await serveText();
    expect(text).toContain('falta la caja fuerte de claves');
    expect(text).toContain('instalar.bat');
    expect(text).not.toMatch(/no vault|run:/);
  });

  it('sin token de Telegram', async () => {
    const text = await serveText();
    expect(text).toContain('Falta el token del bot de Telegram');
    expect(text).toContain('instalar.bat');
    expect(text).toContain('vault set-stdin telegram:botToken');
    expect(text).not.toMatch(/<token>|run:/);
  });

  it('sin ID del dueño', async () => {
    state.secrets = { 'telegram:botToken': 'synthetic-token' };
    const text = await serveText();
    expect(text).toContain('Falta tu ID de Telegram');
    expect(text).toContain('instalar.bat');
    expect(text).not.toMatch(/no allowed users|run:/);
  });
});
