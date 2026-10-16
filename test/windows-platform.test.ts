import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { processAlive } from '../src/lifecycle.js';
import { paths, REPO_DIR } from '../src/paths.js';
import { DESKTOP_ONLY_TOOLS, desktopEnabled, toolsForMode } from '../src/platform.js';
import { envSecretName, loadPortableMap, portableSecretsFile, vaultBackend } from '../src/vault.js';

const isWin = process.platform === 'win32';

afterEach(() => {
  vi.restoreAllMocks();
});

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    if (original) Object.defineProperty(process, 'platform', original);
  }
}

describe('modo escritorio por plataforma', () => {
  it('se activa por defecto solo en win32', () => {
    expect(desktopEnabled({}, 'win32')).toBe(true);
    expect(desktopEnabled({}, 'linux')).toBe(false);
    expect(desktopEnabled({}, 'darwin')).toBe(false);
  });
  it('PA_DESKTOP fuerza el modo en ambos sentidos', () => {
    expect(desktopEnabled({ PA_DESKTOP: 'off' }, 'win32')).toBe(false);
    expect(desktopEnabled({ PA_DESKTOP: '0' }, 'win32')).toBe(false);
    expect(desktopEnabled({ PA_DESKTOP: 'on' }, 'linux')).toBe(true);
    expect(desktopEnabled({ PA_DESKTOP: ' TRUE ' }, 'linux')).toBe(true);
  });
  it('el modo servidor quita todas las herramientas solo-escritorio y deja el resto', () => {
    const all = [...DESKTOP_ONLY_TOOLS, 'memory', 'browser'].map((name) => ({ name }));
    expect(toolsForMode(all, false).map((t) => t.name)).toEqual(['memory', 'browser']);
    expect(toolsForMode(all, true)).toHaveLength(all.length);
  });
  it('shell, computer y ocr son herramientas solo-escritorio', () => {
    for (const name of ['shell', 'computer', 'ocr', 'windows', 'system']) {
      expect(DESKTOP_ONLY_TOOLS.has(name)).toBe(true);
    }
  });
});

describe('backend del vault por plataforma', () => {
  it('usa DPAPI en win32 y portable fuera de Windows', () => {
    expect(vaultBackend({}, 'win32')).toBe('dpapi');
    expect(vaultBackend({}, 'linux')).toBe('portable');
  });
  it('PA_VAULT_BACKEND manda sobre la plataforma, sin distinguir mayúsculas ni espacios', () => {
    expect(vaultBackend({ PA_VAULT_BACKEND: ' Portable ' }, 'win32')).toBe('portable');
    expect(vaultBackend({ PA_VAULT_BACKEND: 'DPAPI' }, 'linux')).toBe('dpapi');
  });
  it('un valor desconocido de PA_VAULT_BACKEND cae al valor por plataforma', () => {
    expect(vaultBackend({ PA_VAULT_BACKEND: 'otro' }, 'win32')).toBe('dpapi');
    expect(vaultBackend({ PA_VAULT_BACKEND: '' }, 'linux')).toBe('portable');
  });
  it('envSecretName produce nombres de variable válidos en Windows (sin : ni minúsculas)', () => {
    expect(envSecretName('provider:apiKey')).toBe('PA_SECRET_PROVIDER_APIKEY');
    expect(envSecretName('telegram:botToken')).toMatch(/^PA_SECRET_[A-Z0-9_]+$/);
  });
});

describe('vault portable con rutas y entorno', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), 'pa-win-'));
    dirs.push(d);
    return d;
  }

  it('portableSecretsFile respeta PA_SECRETS_FILE y recorta espacios', () => {
    const file = join(tmp(), 'sub dir', 'secrets.json');
    expect(portableSecretsFile({ PA_SECRETS_FILE: `  ${file}  ` })).toBe(file);
  });
  it('lee un fichero en una ruta con espacios y fusiona variables de entorno', () => {
    const dir = tmp();
    const file = join(dir, 'ruta con espacios.json');
    writeFileSync(file, JSON.stringify({ 'calendar:icsUrl': 'https://example.invalid/a.ics' }), {
      mode: 0o600,
    });
    const map = loadPortableMap({ PA_SECRET_PROVIDER_APIKEY: 'sintetico' }, file);
    expect(map['calendar:icsUrl']).toBe('https://example.invalid/a.ics');
    expect(map['provider:apiKey']).toBe('sintetico');
  });
  it('un valor de entorno vacío no pisa el del fichero', () => {
    const file = join(tmp(), 's.json');
    writeFileSync(file, JSON.stringify({ 'provider:apiKey': 'del-fichero' }), { mode: 0o600 });
    expect(loadPortableMap({ PA_SECRET_PROVIDER_APIKEY: '' }, file)['provider:apiKey']).toBe(
      'del-fichero',
    );
  });
  it('rechaza un fichero que no es un objeto JSON', () => {
    const file = join(tmp(), 's.json');
    writeFileSync(file, '[1,2]', { mode: 0o600 });
    expect(() => loadPortableMap({}, file)).toThrow(/objeto JSON/);
  });
  it('ignora valores no string y fichero inexistente devuelve mapa vacío', () => {
    const dir = tmp();
    const file = join(dir, 's.json');
    writeFileSync(file, JSON.stringify({ a: 1, b: 'ok' }), { mode: 0o600 });
    const map = loadPortableMap({}, file);
    expect(map.a).toBeUndefined();
    expect(map.b).toBe('ok');
    expect(loadPortableMap({}, join(dir, 'no-existe.json'))).toEqual({});
  });
});

describe('rutas y procesos', () => {
  it('REPO_DIR y las rutas del estado son absolutas y usan el separador de la plataforma', () => {
    expect(isAbsolute(REPO_DIR)).toBe(true);
    expect(REPO_DIR).not.toMatch(/^[\\/][A-Za-z]:/);
    for (const p of Object.values(paths)) expect(isAbsolute(p)).toBe(true);
    expect(relative(paths.state, paths.vault).split(sep)).toEqual(['vault.enc']);
  });
  it('en win32 un EPERM al sondear un pid cuenta como proceso muerto', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('x'), { code: 'EPERM' });
    });
    expect(withPlatform('win32', () => processAlive(4242))).toBe(false);
    expect(withPlatform('linux', () => processAlive(4242))).toBe(true);
  });
  it('ESRCH es proceso muerto y un kill sin error es proceso vivo, en cualquier plataforma', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('x'), { code: 'ESRCH' });
    });
    expect(withPlatform('win32', () => processAlive(1))).toBe(false);
    expect(withPlatform('linux', () => processAlive(1))).toBe(false);
    spy.mockImplementation(() => true);
    expect(withPlatform('win32', () => processAlive(1))).toBe(true);
  });
  it.runIf(isWin)('en Windows real el proceso actual figura como vivo', () => {
    expect(processAlive(process.pid)).toBe(true);
  });
});
