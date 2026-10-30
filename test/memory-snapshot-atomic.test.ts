import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Simula un disco lleno: la escritura de PERFIL deja medio fichero y lanza ENOSPC.
const fail = { on: false };
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    writeFileSync: (file: Parameters<typeof real.writeFileSync>[0], data: string, enc?: never) => {
      if (fail.on && String(file).includes('PERFIL')) {
        real.writeFileSync(file, data.slice(0, Math.floor(data.length / 3)), 'utf8');
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      }
      return real.writeFileSync(file, data, enc);
    },
  };
});
vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const { MemorySnapshot } = await import('../src/memory/snapshot.js');

describe('PERFIL.md ante una escritura fallida', () => {
  it('un disco lleno no destroza el perfil que ya había', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-snap-'));
    const snap = new MemorySnapshot({ dir });
    expect(snap.appendEntry('trabaja en Savvy').ok).toBe(true);
    expect(snap.appendEntry('vive en Valencia').ok).toBe(true);
    const before = readFileSync(join(dir, 'PERFIL.md'), 'utf8');
    fail.on = true;
    expect(snap.appendEntry('tiene un perro llamado Toby').ok).toBe(false);
    fail.on = false;
    expect(readFileSync(join(dir, 'PERFIL.md'), 'utf8')).toBe(before);
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});
