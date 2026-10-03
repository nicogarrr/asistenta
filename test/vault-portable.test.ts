import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESKTOP_ONLY_TOOLS, desktopEnabled } from '../src/platform.js';
import { envSecretName, loadPortableMap, vaultBackend } from '../src/vault.js';

function tmpFile(content: string, mode: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'pa-vault-'));
  const file = join(dir, 'secrets.json');
  writeFileSync(file, content);
  chmodSync(file, mode);
  return file;
}

describe('vaultBackend', () => {
  it('DPAPI en Windows, portable en el resto, y se puede forzar', () => {
    expect(vaultBackend({}, 'win32')).toBe('dpapi');
    expect(vaultBackend({}, 'linux')).toBe('portable');
    expect(vaultBackend({ PA_VAULT_BACKEND: 'portable' }, 'win32')).toBe('portable');
    expect(vaultBackend({ PA_VAULT_BACKEND: 'dpapi' }, 'linux')).toBe('dpapi');
  });
});

describe('envSecretName', () => {
  it('normaliza claves del vault a variables de entorno', () => {
    expect(envSecretName('telegram:botToken')).toBe('PA_SECRET_TELEGRAM_BOTTOKEN');
    expect(envSecretName('provider:apiKey')).toBe('PA_SECRET_PROVIDER_APIKEY');
  });
});

describe('loadPortableMap', () => {
  it('lee solo de variables de entorno, sin archivo', () => {
    const map = loadPortableMap(
      { PA_SECRET_TELEGRAM_BOTTOKEN: 'tok', PA_SECRET_TELEGRAM_ALLOWEDUSERIDS: '1,2' },
      '/no/existe/secrets.json',
    );
    expect(map['telegram:botToken']).toBe('tok');
    expect(map['telegram:allowedUserIds']).toBe('1,2');
  });

  it('el archivo 600 se lee y el entorno gana', () => {
    const file = tmpFile(JSON.stringify({ 'provider:apiKey': 'file', 'x:y': 'z' }), 0o600);
    const map = loadPortableMap({ PA_SECRET_PROVIDER_APIKEY: 'env' }, file);
    expect(map['provider:apiKey']).toBe('env');
    expect(map['x:y']).toBe('z');
  });

  it.skipIf(process.platform === 'win32')('rechaza un archivo legible por otros', () => {
    const file = tmpFile('{}', 0o644);
    expect(() => loadPortableMap({}, file)).toThrow(/chmod 600/);
  });

  it('rechaza JSON que no es un objeto', () => {
    const file = tmpFile('[1]', 0o600);
    expect(() => loadPortableMap({}, file)).toThrow(/objeto JSON/);
  });

  it('ignora valores vacíos del entorno', () => {
    const map = loadPortableMap({ PA_SECRET_TELEGRAM_BOTTOKEN: '' }, '/no/existe');
    expect(map['telegram:botToken']).toBeUndefined();
  });
});

describe('desktopEnabled', () => {
  it('solo por defecto en Windows y se puede forzar', () => {
    expect(desktopEnabled({}, 'win32')).toBe(true);
    expect(desktopEnabled({}, 'linux')).toBe(false);
    expect(desktopEnabled({ PA_DESKTOP: 'on' }, 'linux')).toBe(true);
    expect(desktopEnabled({ PA_DESKTOP: 'off' }, 'win32')).toBe(false);
  });

  it('las herramientas de escritorio están marcadas', () => {
    for (const n of ['computer', 'windows', 'ocr', 'system', 'shell', 'media']) {
      expect(DESKTOP_ONLY_TOOLS.has(n)).toBe(true);
    }
    expect(DESKTOP_ONLY_TOOLS.has('browser')).toBe(false);
  });
});
