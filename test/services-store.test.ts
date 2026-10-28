// FIRST import statement, always - before ANYTHING that transitively loads
// paths.ts: it assigns PA_STATE_DIR (fresh mkdtemp per run) before paths.ts
// can snapshot the real state dir.
// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que vault.js cargue paths.ts
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AdoptedService,
  ServiceStore,
  canonicalServiceName,
  formatServicesList,
  parseService,
  renderService,
} from '../src/services/store.js';

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(FACTORY_TEST_STATE_DIR, 'pa-services-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() ?? '', { recursive: true, force: true });
});

function sample(over: Partial<AdoptedService> = {}): AdoptedService {
  return {
    name: 'kanvas',
    source: 'https://github.com/XMihura/Kanvas',
    version: '0.4.0rc4',
    license: 'MIT',
    cost: 'gratis (PyPI, MIT)',
    method: 'local',
    installRef: 'uvx kanvas-board serve --port 8071',
    port: 8071,
    expose: 'ninguna',
    status: 'propuesto',
    verified: [],
    unverified: ['Tu conexión real desde el móvil sigue sin probar.'],
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
    ...over,
  };
}

describe('canonicalServiceName', () => {
  it('accepts simple names and normalizes case', () => {
    expect(canonicalServiceName('Kanvas')).toBe('kanvas');
    expect(canonicalServiceName('my-board-2')).toBe('my-board-2');
  });
  it('rejects traversal, separators and empty', () => {
    expect(canonicalServiceName('../etc')).toBeNull();
    expect(canonicalServiceName('a/b')).toBeNull();
    expect(canonicalServiceName('')).toBeNull();
    expect(canonicalServiceName('-lead')).toBeNull();
    expect(canonicalServiceName('con espacios')).toBeNull();
  });
});

describe('renderService / parseService round-trip', () => {
  it('round-trips every field', () => {
    const s = sample({ expose: 'tailnet', tailscaleUrl: 'https://pc.tail1234.ts.net' });
    const back = parseService(renderService(s));
    expect(back).toEqual(s);
  });
  it('omits optional fields cleanly', () => {
    const s = sample({ port: undefined, tailscaleUrl: undefined });
    const back = parseService(renderService(s));
    expect(back).toEqual(s);
  });
  it('returns null on a corrupted shape', () => {
    expect(
      parseService('name: ../etc\nmethod: docker\nexpose: tailnet\nstatus: propuesto'),
    ).toBeNull();
    expect(parseService('name: ok\nmethod: nada\nexpose: tailnet\nstatus: propuesto')).toBeNull();
  });
});

describe('ServiceStore', () => {
  it('saves, reads, lists and removes', () => {
    const store = new ServiceStore({ dir: tmp() });
    expect(store.save(sample(), [])).toBe('ok');
    expect(store.read('kanvas')).toEqual(sample());
    expect(store.list().map((s) => s.name)).toEqual(['kanvas']);
    expect(store.remove('kanvas')).toBe(true);
    expect(store.read('kanvas')).toBeNull();
    expect(store.remove('kanvas')).toBe(false);
  });

  it('rejects an invalid record', () => {
    const store = new ServiceStore({ dir: tmp() });
    expect(store.save(sample({ source: ' ' }), [])).toBe('invalid');
  });

  it('blocks a save whose content matches a current vault value', () => {
    const store = new ServiceStore({ dir: tmp() });
    const s = sample({ unverified: ['clave CAN4RY-secreto-sintetico pendiente'] });
    expect(store.save(s, ['CAN4RY-secreto-sintetico'])).toBe('secret');
    expect(store.read('kanvas')).toBeNull();
  });

  it('tolerates a hand-edited file on read', () => {
    const dir = tmp();
    const store = new ServiceStore({ dir });
    writeFileSync(
      join(dir, 'kanvas.md'),
      `${renderService(sample())}\nNota a mano fuera de secciones.\n`,
    );
    expect(store.read('kanvas')?.name).toBe('kanvas');
  });

  it('the saved file is plain readable Markdown with both sections', () => {
    const dir = tmp();
    const store = new ServiceStore({ dir });
    store.save(sample({ verified: ['`docker compose up -d` terminó sin error.'] }), []);
    const raw = readFileSync(join(dir, 'kanvas.md'), 'utf8');
    expect(raw).toContain('## Verificado');
    expect(raw).toContain('## Sin verificar');
    expect(raw).toContain('docker compose up -d');
  });
});

describe('formatServicesList', () => {
  it('explains the empty state', () => {
    expect(formatServicesList([])).toContain('No hay servicios adoptados');
  });
  it('lists status, source, license and tailnet URL', () => {
    const text = formatServicesList([
      sample({ status: 'servido', expose: 'tailnet', tailscaleUrl: 'https://pc.tail1234.ts.net' }),
    ]);
    expect(text).toContain('kanvas [servido]');
    expect(text).toContain('https://pc.tail1234.ts.net');
    expect(text).toContain('MIT');
  });
});
