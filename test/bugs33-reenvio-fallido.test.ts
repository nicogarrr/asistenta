import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureAndAck } from '../src/bandeja/comando.js';
import { BandejaQueue, type ProcesarDeps } from '../src/bandeja/procesar.js';
import { BandejaStore } from '../src/bandeja/store.js';

// bugs-33 (11 nov 2026): una cosa que falló al procesarse (la página no abrió, el PDF no
// bajó) se queda en ⚠️. Lo natural es volver a mandarla… y la bandeja contestaba «📥 Eso ya
// estaba en la bandeja» sin hacer nada: el reenvío no la reintentaba nunca. Con los
// ficheros (huella sha256), la copia nueva se cerraba como «repetido» de la que falló.

const CHAT = '111';
const NOV11 = new Date('2026-11-11T09:00:00Z');
const REPLY =
  'TITULO: T\nVEREDICTO: IDEAS\nNOTA: 6\nMOTIVO: m\nIDEAS:\n- a\n- b\n- c\nETIQUETAS: ninguna';
const PAGE = `<html><head><title>Artículo</title></head><body><article>${'<p>Texto del artículo con bastantes palabras para leer. </p>'.repeat(60)}</article></body></html>`;
const PDF = Buffer.from('%PDF-1.4 el mismo');

let dir: string;
let store: BandejaStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bugs33-reenvio-'));
  store = new BandejaStore(join(dir, 'bandeja.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('bandeja: volver a mandar algo que falló lo reintenta', () => {
  it('un enlace que falló se vuelve a mirar al mandarlo otra vez', async () => {
    let up = false;
    const deps: ProcesarDeps = {
      complete: async () => async () => REPLY,
      fetchRaw: async () => {
        if (!up) throw new Error('ECONNRESET');
        return PAGE;
      },
      videoText: async () => ({ ok: false, reason: 'no' }) as never,
    };
    const queue = new BandejaQueue(store, deps);
    const ctx = { store, queue, chatId: CHAT, now: () => NOV11, env: {} };
    const first = captureAndAck(ctx, [{ kind: 'enlace', url: 'https://blog.example/post' }]);
    await queue.idle();
    const id = first.itemId as number;
    expect(store.get(id)?.status).toBe('error');
    up = true; // la red vuelve; Nico lo manda otra vez
    const again = captureAndAck(ctx, [{ kind: 'enlace', url: 'https://blog.example/post' }]);
    expect(again.text).not.toMatch(/ya estaba en la bandeja/);
    expect(again.text).toMatch(/vuelvo a mirar|otra vez/i);
    await queue.idle();
    expect(store.get(id)?.status).toBe('listo');
  });

  it('el mismo PDF mandado otra vez tras fallar se procesa (no es «repetido» de la que falló)', async () => {
    let ok = false;
    const deps: ProcesarDeps = {
      complete: async () => async () => REPLY,
      fetchRaw: async () => '',
      videoText: async () => ({ ok: false, reason: 'no' }) as never,
      download: async () => PDF,
      pdfText: async () => {
        if (!ok) throw new Error('pdf roto');
        return 'palabra '.repeat(300);
      },
    };
    const queue = new BandejaQueue(store, deps);
    const ctx = { store, queue, chatId: CHAT, now: () => NOV11, env: {} };
    const a = captureAndAck(ctx, [{ kind: 'pdf', fileId: 'f1', fileName: 'x.pdf' }]);
    await queue.idle();
    expect(store.get(a.itemId as number)?.status).toBe('error');
    ok = true;
    const b = captureAndAck(ctx, [{ kind: 'pdf', fileId: 'f2', fileName: 'x.pdf' }]);
    await queue.idle();
    expect(store.get(b.itemId as number)?.status).toBe('listo');
    // La que falló no se queda como un ⚠️ suelto al lado de la buena.
    expect(store.get(a.itemId as number)?.state).toBe('descartado');
  });
});
