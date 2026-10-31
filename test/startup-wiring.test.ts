import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ path: '' }));
const mocks = vi.hoisted(() => ({ provider: vi.fn(), telegram: vi.fn() }));
vi.mock('../src/core/provider.js', async (original) => ({
  ...(await original<typeof import('../src/core/provider.js')>()),
  createProviderHandle: mocks.provider,
}));
vi.mock('../src/startup.js', async (original) => ({
  ...(await original<typeof import('../src/startup.js')>()),
  checkTelegramToken: mocks.telegram,
}));
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
  vaultExists: () => true,
  unlock: vi.fn(),
  vaultGet: async (key: string) =>
    key === 'telegram:botToken'
      ? 'synthetic-token'
      : key === 'telegram:allowedUserIds'
        ? '123'
        : undefined,
}));

import { main } from '../src/cli.js';

state.path = mkdtempSync(join(tmpdir(), 'pa-startup-wiring-'));
afterAll(() => rmSync(state.path, { recursive: true, force: true }));
beforeEach(() => {
  vi.restoreAllMocks();
  mocks.provider.mockReset();
  mocks.telegram.mockReset();
});
describe('serve preflight wiring', () => {
  it('stops before channels and threads when the provider key is missing', async () => {
    mocks.provider.mockRejectedValue(new Error('no API key: SECRET-do-not-leak'));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await main(['serve'])).toBe(1);
    expect(mocks.provider).toHaveBeenCalledOnce();
    expect(mocks.telegram).not.toHaveBeenCalled();
    const text = stderr.mock.calls.map(([s]) => String(s)).join('');
    expect(text).toContain('Falta la clave');
    expect(text).not.toContain('SECRET');
  });
  it('stops with a clear token error before announcing readiness', async () => {
    mocks.provider.mockResolvedValue({});
    mocks.telegram.mockRejectedValue(new Error('El token de Telegram no es válido.'));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await main(['serve'])).toBe(1);
    expect(mocks.telegram).toHaveBeenCalledWith(
      'synthetic-token',
      expect.anything(),
      expect.objectContaining({ delaysMs: expect.any(Array) }),
    );
    expect(stderr.mock.calls.map(([s]) => String(s)).join('')).toContain(
      'El token de Telegram no es válido',
    );
  });
});
