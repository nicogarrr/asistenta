import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// `pa chat` sin clave del modelo: el mensaje salía a los 0,4 s pero la consola
// quedaba bloqueada 15 s (retención fail-closed de controlled-daemon tras
// beginResources). Ahora la clave se comprueba ANTES de reservar nada.

vi.mock('../src/daemon-control.js', () => ({
  openDaemonControl: async () => ({ ready: () => {}, close: async () => {} }),
}));
vi.mock('../src/platform.js', async (orig) => ({
  ...(await orig<typeof import('../src/platform.js')>()),
  desktopEnabled: () => false,
}));

const { controlledDaemon } = await import('../src/controlled-daemon.js');
const { checkProviderKey } = await import('../src/core/provider.js');

const sinClave = {
  provider: 'propio',
  baseUrl: 'https://modelo.example.test/v1',
} as unknown as Parameters<typeof checkProviderKey>[0];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('pa chat sin clave sale al momento', () => {
  it('checkProviderKey falla sin red ni modelos; opencode-local no pide clave', async () => {
    const prev = process.env.PA_API_KEY;
    delete process.env.PA_API_KEY;
    try {
      await expect(checkProviderKey(sinClave)).rejects.toThrow(/no API key/);
      await expect(
        checkProviderKey({ ...sinClave, provider: 'opencode-local' }),
      ).resolves.toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.PA_API_KEY = prev;
    }
  });

  it.runIf(process.platform === 'linux' || process.platform === 'win32')(
    'reloj falso: la comprobación antes de beginResources no deja la retención de 15 s',
    async () => {
      vi.useFakeTimers();
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      delete process.env.PA_API_KEY;
      await expect(
        controlledDaemon(async (ctl) => {
          await checkProviderKey(sinClave); // orden de chatCommand
          ctl?.beginResources();
          return 0;
        }),
      ).rejects.toThrow(/no API key/);
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(20_000);
      expect(exit).not.toHaveBeenCalled();
    },
  );

  it('`pa chat` sin clave termina en menos de 5 s con el mensaje en castellano', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-chat-sin-clave-'));
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, PA_STATE_DIR: dir, PA_DESKTOP: 'off' };
      for (const k of Object.keys(env)) if (/API_KEY$/.test(k)) delete env[k];
      delete env.FORCE_COLOR;
      delete env.NO_COLOR;
      const t0 = Date.now();
      const r = spawnSync(process.execPath, [resolve('dist/cli.js'), 'chat'], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 60_000,
        env,
        input: '',
      });
      const ms = Date.now() - t0;
      expect(r.stderr).toMatch(/Falta la clave del modelo/);
      expect(r.stderr).toMatch(/pa vault set-stdin provider:apiKey/);
      expect(r.status).toBe(1);
      expect(ms).toBeLessThan(5_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 70_000);
});
