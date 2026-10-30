import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { resolveOcrPath, runOcrSidecar } from '../src/tools/ocr-local.js';

/** Proceso falso: el sidecar real (Python, pesos) nunca se lanza en los tests. */
function fakeChild(script: (c: FakeChild) => void) {
  const calls: { cmd: string; args: string[] }[] = [];
  let last: FakeChild | undefined;
  const spawnFn = (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const c = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      killed: '' as string,
      kill(sig: string) {
        c.killed = sig;
        return true;
      },
    });
    last = c;
    queueMicrotask(() => script(c));
    // biome-ignore lint/suspicious/noExplicitAny: proceso falso con la forma mínima
    return c as any;
  };
  return { spawnFn, calls, child: () => last };
}
type FakeChild = EventEmitter & { stdout: PassThrough; stderr: PassThrough; killed: string };

const base = { python: 'py', script: 'ocr_sidecar.py', model: 'ppocr' as const, file: '/x/a.png' };

describe('rutas: solo dentro de las carpetas permitidas', () => {
  const root = mkdtempSync(join(tmpdir(), 'pa-ocr-'));
  const ok = join(root, 'dentro', 'ticket.png');
  mkdirSync(join(root, 'dentro'));
  writeFileSync(ok, 'x');
  const outside = mkdtempSync(join(tmpdir(), 'pa-ocr-fuera-'));
  writeFileSync(join(outside, 'secreto.png'), 'x');
  writeFileSync(join(root, 'nota.txt'), 'x');

  it('acepta un fichero dentro', async () => {
    await expect(resolveOcrPath(ok, [root])).resolves.toMatch(/ticket\.png$/);
  });

  it('rechaza ../, rutas fuera y lo que no es imagen ni PDF', async () => {
    await expect(resolveOcrPath(join(root, 'nota.txt'), [root])).rejects.toThrow(/imágenes o PDF/);
    await expect(resolveOcrPath(join(root, '..', 'x.png'), [root])).rejects.toThrow();
    await expect(resolveOcrPath(join(outside, 'secreto.png'), [root])).rejects.toThrow(
      /fuera de las carpetas permitidas/,
    );
  });

  it('rechaza un enlace simbólico que sale fuera', async () => {
    const link = join(root, 'enlace.png');
    symlinkSync(join(outside, 'secreto.png'), link);
    await expect(resolveOcrPath(link, [root])).rejects.toThrow(/fuera de las carpetas/);
  });
});

describe('sidecar (simulado)', () => {
  it('lanza el script con modelo y fichero y lee su JSON', async () => {
    const f = fakeChild((c) => {
      c.stdout.end(`${JSON.stringify({ ok: true, text: 'TOTAL 12,50 €', pages: 1 })}\n`);
      c.emit('close', 0);
    });
    const r = await runOcrSidecar({ ...base, model: 'glm', spawnFn: f.spawnFn });
    expect(r).toEqual({ text: 'TOTAL 12,50 €', pages: 1 });
    expect(f.calls[0]).toEqual({
      cmd: 'py',
      args: ['ocr_sidecar.py', '--model', 'glm', '--input', '/x/a.png'],
    });
  });

  it('sin el motor instalado: mensaje en castellano con cómo instalarlo', async () => {
    const enoent = fakeChild((c) =>
      c.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' })),
    );
    await expect(runOcrSidecar({ ...base, spawnFn: enoent.spawnFn })).rejects.toThrow(
      /no está instalado.*setup\.ps1 -Model ppocr/,
    );
    const missing = fakeChild((c) => {
      c.stdout.end('{"ok":false,"error":"missing_engine","detail":"No module named rapidocr"}');
      c.emit('close', 2);
    });
    await expect(runOcrSidecar({ ...base, spawnFn: missing.spawnFn })).rejects.toThrow(
      /no está instalado/,
    );
  });

  it('se para por tiempo y por exceso de salida, matando el proceso', async () => {
    const hang = fakeChild(() => {});
    await expect(runOcrSidecar({ ...base, timeoutMs: 20, spawnFn: hang.spawnFn })).rejects.toThrow(
      /tardó más de/,
    );
    expect(hang.child()?.killed).toBe('SIGKILL');
    const flood = fakeChild((c) => c.stdout.write('x'.repeat(100)));
    await expect(
      runOcrSidecar({ ...base, maxOutputBytes: 10, spawnFn: flood.spawnFn }),
    ).rejects.toThrow(/demasiada salida/);
    expect(flood.child()?.killed).toBe('SIGKILL');
  });

  it('una salida que no es JSON es un fallo legible', async () => {
    const bad = fakeChild((c) => {
      c.stderr.write('Traceback\nRuntimeError: boom\n');
      c.stdout.end('');
      c.emit('close', 1);
    });
    await expect(runOcrSidecar({ ...base, spawnFn: bad.spawnFn })).rejects.toThrow(
      /RuntimeError: boom/,
    );
  });
});
