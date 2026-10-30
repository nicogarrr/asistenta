import { describe, expect, it } from 'vitest';
import { type PreflightDeps, preflightExitCode, runPreflight } from '../src/preflight.js';

const GB = 1024 ** 3;

function deps(vault: Record<string, string>): PreflightDeps {
  const store: Record<string, string> = { 'telegram:botToken': '123:abc', ...vault };
  return {
    nodeVersion: 'v24.3.0',
    platform: 'win32',
    vaultExists: () => true,
    unlock: async () => {},
    vaultGet: async (k) => store[k],
    checkTelegramToken: async () => {},
    checkProvider: async () => {},
    providerFailureMessage: () => 'x',
    tvReachable: async () => true,
    desktopEnabled: () => true,
    computerUseEnabled: () => true,
    mailStatus: async () => ({ read: 'ok', send: 'ok' }),
    freeDiskBytes: async () => 20 * GB,
    offline: true,
  };
}

const dueno = async (vault: Record<string, string>) =>
  (await runPreflight(deps(vault))).find((c) => c.id === 'dueno');

describe('pa iniciar: dueño (chat privado de Nico)', () => {
  it('un solo usuario autorizado es el dueño', async () => {
    const c = await dueno({ 'telegram:allowedUserIds': '42' });
    expect(c?.status).toBe('ok');
    expect(c?.detail).toContain('42');
  });

  it('varios usuarios sin dueño elegido: aviso con el arreglo, sin fallar el arranque', async () => {
    const checks = await runPreflight(deps({ 'telegram:allowedUserIds': '42,77' }));
    const c = checks.find((x) => x.id === 'dueno');
    expect(c?.status).toBe('aviso');
    expect(c?.detail).toMatch(/no sé cuál es tu chat privado/);
    expect(c?.hint).toBe('pa vault set vigilante:ownerUserId <tu id de Telegram>');
    expect(preflightExitCode(checks)).toBe(0);
  });

  it('dueño elegido entre los autorizados: ok', async () => {
    const c = await dueno({
      'telegram:allowedUserIds': '42,77',
      'vigilante:ownerUserId': '77',
    });
    expect(c?.status).toBe('ok');
    expect(c?.detail).toContain('77');
  });

  it('dueño elegido que no está autorizado: aviso (el daemon no lo usaría)', async () => {
    const c = await dueno({
      'telegram:allowedUserIds': '42,77',
      'vigilante:ownerUserId': '99',
    });
    expect(c?.status).toBe('aviso');
    expect(c?.detail).toMatch(/99/);
    expect(c?.hint).toMatch(/telegram:allowedUserIds|vigilante:ownerUserId/);
  });

  it('sin usuarios autorizados no añade otra línea (ya falla «Usuarios autorizados»)', async () => {
    expect(await dueno({ 'telegram:allowedUserIds': '' })).toBeUndefined();
  });
});
