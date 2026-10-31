import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const reads = vi.hoisted(() => ({ files: [] as string[] }));
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>();
  const readFileSync = ((path: unknown, ...rest: unknown[]) => {
    reads.files.push(String(path));
    return (real.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof real.readFileSync;
  return { ...real, default: { ...real, readFileSync }, readFileSync };
});

const { appendCallAudit, verifyCallAudit } = await import('../src/audit/calls.js');

// robustez-7: el registro de llamadas crece con cada herramienta; añadir una
// línea no debe leer el fichero entero (cada día iba más lento). El contenido y
// la cadena de hashes no cambian.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('auditoría de llamadas: añadir sin leer todo el fichero', () => {
  it('encadena bien leyendo solo el final, también con un registro grande', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-audit-tail-'));
    dirs.push(dir);
    const file = join(dir, 'calls.jsonl');
    appendCallAudit({ callId: 'a', tool: 't', argsHash: 'x', verdict: 'allow' }, file);
    for (let i = 0; i < 400; i++) {
      appendCallAudit(
        { callId: `c${i}`, tool: 't', argsHash: 'x'.repeat(300), verdict: 'allow' },
        file,
      );
    }
    reads.files.length = 0;
    appendCallAudit({ callId: 'z', tool: 'ñandú', argsHash: 'y', verdict: 'deny' }, file);
    expect(reads.files.filter((f) => f === file)).toEqual([]);
    expect(verifyCallAudit(file)).toEqual({ ok: true, entries: 402 });
  });

  it('una cola rota no impide seguir añadiendo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-audit-tail-'));
    dirs.push(dir);
    const file = join(dir, 'calls.jsonl');
    writeFileSync(file, '{roto\n');
    appendCallAudit({ callId: 'a', tool: 't', argsHash: 'x', verdict: 'allow' }, file);
    expect(verifyCallAudit(file).ok).toBe(false);
  });
});
