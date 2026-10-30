import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServedFile } from '../src/audio/lan-server.js';
import { tvCasterFromVault } from '../src/audio/tv-cast.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

// Tele falsa: nunca hay red real. Si la tele ha olvidado la client-key, el
// cliente SSAP la re-empareja y entrega la NUEVA por onNewClientKey.
let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-tvcast-key-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const vault: Record<string, string> = { 'tv:host': '192.168.1.50', 'tv:clientKey': 'VIEJA' };
const vaultGet = async (k: string): Promise<string | null> => vault[k] ?? null;
const served: ServedFile = {
  url: 'http://192.168.1.10:9/abc/a.mp3',
  hits: () => 1,
  close: () => {},
  closed: Promise.resolve(),
};
const extra = { pickAddress: () => '192.168.1.10', serve: async () => served };

type Deps = { allowPlaintext?: boolean; onNewClientKey?: (k: string) => void | Promise<void> };

describe('tvCasterFromVault guarda la client-key nueva (re-emparejado durante un cast)', () => {
  it('pasa onNewClientKey al cliente y guarda la clave con saveClientKey', async () => {
    const file = join(dir, 'a.mp3');
    writeFileSync(file, 'x');
    const saved: string[] = [];
    const request = vi.fn(
      async (_h: string, _k: string, _uri: string, _p: Record<string, unknown>, deps?: Deps) => {
        await deps?.onNewClientKey?.('NUEVA');
        return {};
      },
    );
    const r = await tvCasterFromVault(vaultGet, request, {
      ...extra,
      saveClientKey: async (k) => {
        saved.push(k);
      },
    })(file);
    expect(r.ok).toBe(true);
    expect(saved).toEqual(['NUEVA']);
  });

  it('la siguiente vía del mismo cast usa ya la clave nueva (no vuelve a salir el aviso)', async () => {
    const file = join(dir, 'b.mp3');
    writeFileSync(file, 'x');
    const keys: string[] = [];
    const request = vi.fn(
      async (_h: string, k: string, uri: string, _p: Record<string, unknown>, deps?: Deps) => {
        keys.push(k);
        if (uri === 'media.viewer/open') {
          await deps?.onNewClientKey?.('NUEVA');
          throw new Error('404 no such service');
        }
        return {};
      },
    );
    const r = await tvCasterFromVault(vaultGet, request, {
      ...extra,
      saveClientKey: async () => {},
    })(file);
    expect(r.ok).toBe(true);
    expect(r.via).toBe('launcher');
    expect(keys).toEqual(['VIEJA', 'NUEVA']);
  });

  it('si guardar la clave falla, el cast no se cae', async () => {
    const file = join(dir, 'c.mp3');
    writeFileSync(file, 'x');
    const request = vi.fn(
      async (_h: string, _k: string, _uri: string, _p: Record<string, unknown>, deps?: Deps) => {
        await deps?.onNewClientKey?.('NUEVA');
        return {};
      },
    );
    const r = await tvCasterFromVault(vaultGet, request, {
      ...extra,
      saveClientKey: async () => {
        throw new Error('vault bloqueado');
      },
    })(file);
    expect(r.ok).toBe(true);
    expect(r.via).toBe('media.viewer');
  });

  it('sin saveClientKey se comporta como antes (la clave guardada no cambia)', async () => {
    const file = join(dir, 'd.mp3');
    writeFileSync(file, 'x');
    const keys: string[] = [];
    const request = vi.fn(
      async (_h: string, k: string, _uri: string, _p: Record<string, unknown>, deps?: Deps) => {
        keys.push(k);
        expect(deps?.onNewClientKey).toBeUndefined();
        return {};
      },
    );
    const r = await tvCasterFromVault(vaultGet, request, extra)(file);
    expect(r.ok).toBe(true);
    expect(keys).toEqual(['VIEJA']);
  });
});
