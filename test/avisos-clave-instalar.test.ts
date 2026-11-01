import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type PreflightDeps, runPreflight } from '../src/preflight.js';
import { startupFailureMessage } from '../src/startup.js';

/** Sin clave o sin caja fuerte, el aviso lleva a instalar.bat y a set-stdin, en castellano. */
describe('avisos de clave que faltan', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('sin clave del modelo: instalar.bat o set-stdin, nunca la clave en la orden', () => {
    const msg = startupFailureMessage(
      new Error('no API key: run `pa vault set provider:apiKey <key>`'),
    );
    expect(msg).toContain('instalar.bat');
    expect(msg).toContain('pa vault set-stdin provider:apiKey');
    expect(msg).not.toMatch(/vault set provider/);
  });

  it('OpenRouter y Gemini: también con set-stdin', () => {
    expect(startupFailureMessage(new Error('no OpenRouter API key: x'))).toContain(
      'pa vault set-stdin provider:openrouterKey',
    );
    expect(startupFailureMessage(new Error('no Gemini API key: x'))).toContain(
      'pa vault set-stdin provider:geminiKey',
    );
  });

  it('sin caja fuerte (Windows): castellano y lleva a instalar.bat', async () => {
    vi.stubEnv('PA_VAULT_BACKEND', 'dpapi');
    vi.stubEnv('PA_STATE_DIR', mkdtempSync(join(tmpdir(), 'pa-sin-vault-')));
    vi.resetModules();
    const vault = await import('../src/vault.js');
    const err = await vault.vaultList().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/caja fuerte/);
    expect((err as Error).message).toContain('instalar.bat');
    expect((err as Error).message).not.toMatch(/no vault at|run:/);
  });

  it('pa iniciar: sin caja fuerte, token o ID, la pista lleva a instalar.bat y nunca pone el token en la orden', async () => {
    const base: PreflightDeps = {
      nodeVersion: 'v24.3.0',
      platform: 'win32',
      vaultExists: () => true,
      unlock: async () => {},
      vaultGet: async () => undefined,
      checkTelegramToken: async () => {},
      checkProvider: async () => {
        throw new Error('no API key');
      },
      providerFailureMessage: startupFailureMessage,
      tvReachable: async () => true,
      desktopEnabled: () => true,
      computerUseEnabled: () => true,
      mailStatus: async () => ({ read: 'ok', send: 'ok' }),
      freeDiskBytes: async () => 20 * 1024 ** 3,
    };
    const c = Object.fromEntries((await runPreflight(base)).map((x) => [x.id, x]));
    for (const id of ['telegram', 'usuarios', 'modelo'])
      expect(c[id]?.hint).toContain('instalar.bat');
    expect(c.telegram?.hint).not.toMatch(/vault set telegram:botToken/);
    expect(c.modelo?.hint).not.toMatch(/vault set provider/);
    const sinVault = await runPreflight({ ...base, vaultExists: () => false });
    expect(sinVault.find((x) => x.id === 'vault')?.hint).toContain('instalar.bat');
  });
});
