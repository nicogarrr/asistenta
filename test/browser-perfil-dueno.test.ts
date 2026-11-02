import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ownerBrowserProfileKey, profileDirFor, sharedProfileDir } from '../src/browser/service.js';

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});
const base = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'pa-perfil-'));
  tmp.push(d);
  return d;
};

describe('Chrome del dueño: un solo perfil para todos sus hilos', () => {
  it('los hilos del DM del dueño comparten clave; los demás chats no', () => {
    expect(ownerBrowserProfileKey('telegram:dm:42#main', 42)).toBe('dueno');
    expect(ownerBrowserProfileKey('telegram:dm:42#viajes', 42)).toBe('dueno');
    expect(ownerBrowserProfileKey('telegram:dm:43#main', 42)).toBeUndefined();
    expect(ownerBrowserProfileKey('telegram:-100123#main', 42)).toBeUndefined();
    expect(ownerBrowserProfileKey('telegram:dm:42#main', null)).toBeUndefined();
    expect(ownerBrowserProfileKey('telegram:dm:42#main', undefined)).toBeUndefined();
  });

  it('no confunde ids que solo empiezan igual (42 vs 421)', () => {
    expect(ownerBrowserProfileKey('telegram:dm:421#main', 42)).toBeUndefined();
  });

  it('el perfil compartido es uno solo y distinto del de cualquier hilo', () => {
    const b = base();
    const a = sharedProfileDir('dueno', b);
    expect(sharedProfileDir('dueno', b)).toBe(a);
    expect(a).not.toBe(profileDirFor('telegram:dm:42#main', b));
    expect(a.startsWith(b)).toBe(true);
  });
});

describe('Chrome del dueño: relevo del perfil compartido entre hilos', () => {
  it('abrir el navegador de otro hilo del dueño cierra el anterior y usa la misma carpeta', async () => {
    const { chromium } = await import('playwright');
    const { BrowserService } = await import('../src/browser/service.js');
    const lanzados: string[] = [];
    const cerrados: string[] = [];
    const fingir = (dir: string) => {
      const page = new Proxy(
        { isClosed: () => false },
        { get: (t, k) => (k in t ? (t as never)[k] : () => Promise.resolve(undefined)) },
      );
      return {
        pages: () => [page],
        newPage: async () => page,
        setDefaultTimeout: () => undefined,
        setDefaultNavigationTimeout: () => undefined,
        close: async () => {
          cerrados.push(dir);
        },
        route: async () => undefined,
        on: () => undefined,
        addInitScript: async () => undefined,
        exposeFunction: async () => undefined,
      };
    };
    const { vi } = await import('vitest');
    const spy = vi
      .spyOn(chromium, 'launchPersistentContext')
      .mockImplementation(async (dir: string) => {
        lanzados.push(dir);
        return fingir(dir) as never;
      });
    const b = base();
    const opciones = {
      profilesDir: b,
      policy: {
        autoApprove: true,
        allowPrivateHosts: true,
        adSkipIntervalMs: 0,
        approve: async () => true,
      },
      sharedProfileKey: (scope: string) => ownerBrowserProfileKey(scope, 42),
    };
    const uno = new BrowserService(opciones);
    const dos = new BrowserService(opciones);
    try {
      await uno.open('telegram:dm:42#main', 'http://example.com/').catch(() => undefined);
      await dos.open('telegram:dm:42#viajes', 'http://example.com/').catch(() => undefined);
      expect(lanzados.length).toBe(2);
      expect(lanzados[0]).toBe(lanzados[1]);
      expect(cerrados).toContain(lanzados[0]);
      expect(uno.isOpen('telegram:dm:42#main')).toBe(false);
      expect(dos.isOpen('telegram:dm:42#viajes')).toBe(true);
    } finally {
      spy.mockRestore();
      await uno.closeAll().catch(() => undefined);
      await dos.closeAll().catch(() => undefined);
    }
  });

  it('otro chat no toca el perfil del dueño', async () => {
    const { chromium } = await import('playwright');
    const { BrowserService } = await import('../src/browser/service.js');
    const { vi } = await import('vitest');
    const lanzados: string[] = [];
    const spy = vi
      .spyOn(chromium, 'launchPersistentContext')
      .mockImplementation(async (dir: string) => {
        lanzados.push(dir);
        throw new Error('fixture');
      });
    const b = base();
    const s = new BrowserService({
      profilesDir: b,
      policy: {
        autoApprove: true,
        allowPrivateHosts: true,
        adSkipIntervalMs: 0,
        approve: async () => true,
      },
      sharedProfileKey: (scope: string) => ownerBrowserProfileKey(scope, 42),
    });
    try {
      await s.open('telegram:-100123#main', 'http://example.com/').catch(() => undefined);
      expect(lanzados[0]).not.toBe(sharedProfileDir('dueno', b));
      expect(lanzados[0]?.startsWith(b)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
