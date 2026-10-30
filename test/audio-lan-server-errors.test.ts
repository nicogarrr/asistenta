import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serveFileToHost } from '../src/audio/lan-server.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

// El servidor efímero corre dentro del daemon: un fallo leyendo o borrando el
// fichero no puede tumbar el proceso (excepción no capturada).
let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-lan-err-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** GET que se resuelve cuando la respuesta termina o la conexión se corta. */
function fetchEnds(url: string): Promise<'end' | 'cut'> {
  return new Promise((resolve) => {
    const req = get(url, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve('end'));
      res.on('error', () => resolve('cut'));
      res.on('aborted', () => resolve('cut'));
      res.on('close', () => resolve(res.complete ? 'end' : 'cut'));
    });
    req.on('error', () => resolve('cut'));
  });
}

describe('serveFileToHost ante errores del disco', () => {
  it('si leer el fichero falla después del stat, corta esa descarga sin excepción no capturada', async () => {
    // Un directorio pasa el statSync pero createReadStream falla (EISDIR): mismo camino
    // que un fichero borrado o bloqueado entre el stat y la lectura.
    const fake = join(dir, 'nota.mp3');
    mkdirSync(fake);
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown): void => {
      uncaught.push(err);
    };
    process.on('uncaughtException', onUncaught);
    const served = await serveFileToHost({
      file: fake,
      bindIp: '127.0.0.1',
      allowIp: '127.0.0.1',
      deleteOnClose: false,
    });
    try {
      const r = await fetchEnds(served.url);
      expect(r).toBe('cut');
      await new Promise((ok) => setTimeout(ok, 50));
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
      served.close();
    }
  }, 5000);

  it('close() no lanza aunque no se pueda borrar el fichero, y el servidor se cierra', async () => {
    const fake = join(dir, 'bloqueado.mp3');
    mkdirSync(fake); // rmSync sin recursive falla: simula EBUSY/EPERM de Windows
    const served = await serveFileToHost({ file: fake, bindIp: '127.0.0.1', allowIp: '127.0.0.1' });
    expect(() => served.close()).not.toThrow();
    await served.closed;
  }, 5000);
});
