import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../src/memory.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

// bugs29: «olvida que vivo en malaga» (sin tilde, escrito deprisa) no borraba «Vivo en Málaga»
// y la respuesta era que no había nada que olvidar; y al revés.
let dir = '';
let store: MemoryStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'b29-olvida-'));
  store = new MemoryStore(dir);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('olvidar sin depender de las tildes (bugs29)', () => {
  it('borra aunque una de las dos no lleve tilde', () => {
    store.remember('s', 'Vivo en Málaga desde 2020');
    store.remember('s', 'Mi médico es el Dr. Pérez');
    store.remember('s', 'Prefiero el café solo');
    expect(store.forgetMatching('s', 'malaga')).toHaveLength(1);
    expect(store.forgetMatching('s', 'medico es el dr. perez')).toHaveLength(1);
    expect(store.forgetMatching('s', 'cafe solo')).toHaveLength(1);
    expect(store.all('s')).toEqual([]);
  });

  it('lo que no está no se borra', () => {
    store.remember('s', 'Vivo en Málaga');
    expect(store.forgetMatching('s', 'valencia')).toEqual([]);
    expect(store.all('s')).toHaveLength(1);
  });
});
