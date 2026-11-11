import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BandejaQueue, type ProcesarDeps } from '../src/bandeja/procesar.js';
import { BandejaStore } from '../src/bandeja/store.js';

// bugs-33 (11 nov 2026): «📖 Al Kindle» de un vídeo viejo (procesado antes de que se
// guardara el texto) volvía a transcribirlo POR SU CUENTA, a la vez que la cola de la
// bandeja transcribía otra cosa: dos whisper en el PC a la vez (CPU al 100 % y los dos
// el doble de lentos), y sin tope propio para la espera. Ahora la transcripción va de
// una en una (la de la cola y la del Kindle comparten turno) y el Kindle tiene su tope.

const CHAT = '111';
const NOV11 = new Date('2026-11-11T09:00:00Z');
const REPLY =
  'TITULO: T\nVEREDICTO: IDEAS\nNOTA: 6\nMOTIVO: m\nIDEAS:\n- a\n- b\n- c\nETIQUETAS: ninguna';
const TEXT = 'palabra '.repeat(400);

let dir: string;
let store: BandejaStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bugs33-kindle-cola-'));
  store = new BandejaStore(join(dir, 'bandeja.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function video(id: string) {
  return store.add(
    CHAT,
    { kind: 'youtube', url: `https://www.youtube.com/watch?v=${id}` },
    NOV11,
    '2026-11-11',
  ).item;
}

/** Un whisper falso que cuenta cuántos van a la vez y que se suelta a mano. */
function fakeWhisper() {
  let active = 0;
  let maxActive = 0;
  const calls: string[] = [];
  const pending: Array<() => void> = [];
  const videoText: ProcesarDeps['videoText'] = (url, opts) =>
    new Promise((resolve, reject) => {
      calls.push(url);
      active++;
      maxActive = Math.max(maxActive, active);
      const done = () => {
        active--;
        resolve({
          ok: true,
          text: TEXT,
          source: 'audio',
          meta: { title: `Vídeo ${url.slice(-2)}`, author: 'A', durationSeconds: 3600 },
        } as never);
      };
      pending.push(done);
      opts?.signal?.addEventListener('abort', () => {
        active--;
        reject(opts.signal?.reason ?? new Error('abort'));
      });
    });
  return {
    videoText,
    calls,
    release: () => pending.shift()?.(),
    get maxActive() {
      return maxActive;
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe('bandeja: «📖 Al Kindle» no transcribe a la vez que la cola', () => {
  it('el Kindle de un vídeo espera a que termine el whisper de la cola (nunca dos a la vez)', async () => {
    const w = fakeWhisper();
    const deps: ProcesarDeps = {
      complete: async () => async () => REPLY,
      fetchRaw: async () => '',
      videoText: w.videoText,
    };
    const queue = new BandejaQueue(store, deps);
    const busy = video('aa');
    const old = video('bb');
    void queue.enqueue(busy.id);
    await tick();
    expect(w.calls).toHaveLength(1); // la cola está transcribiendo «aa»
    const kindle = queue.readable(old);
    await tick();
    expect(w.calls).toHaveLength(1); // el Kindle espera su turno
    w.release(); // termina «aa»
    await tick();
    expect(w.calls).toHaveLength(2);
    w.release();
    const r = await kindle;
    expect(r.text).toContain('palabra');
    await queue.idle();
    expect(w.maxActive).toBe(1);
  });

  it('si mientras esperaba la cola ya guardó el texto de esa cosa, no se transcribe otra vez', async () => {
    const w = fakeWhisper();
    const deps: ProcesarDeps = {
      complete: async () => async () => REPLY,
      fetchRaw: async () => '',
      videoText: w.videoText,
    };
    const queue = new BandejaQueue(store, deps);
    const it1 = video('cc');
    store.saveText(it1.id, 'texto ya guardado '.repeat(50));
    const r = await queue.readable(it1);
    expect(r.text).toContain('texto ya guardado');
    expect(w.calls).toHaveLength(0);
  });

  it('el Kindle tiene su propio tope: un whisper que no acaba no lo deja colgado', async () => {
    const w = fakeWhisper();
    const deps: ProcesarDeps = {
      complete: async () => async () => REPLY,
      fetchRaw: async () => '',
      videoText: w.videoText,
    };
    const queue = new BandejaQueue(store, deps);
    const old = video('dd');
    await expect(queue.readable(old, 60)).rejects.toThrow();
    // Y el turno queda libre: lo siguiente de la cola transcribe.
    const next = video('ee');
    void queue.enqueue(next.id);
    await tick();
    expect(w.calls).toHaveLength(2);
    w.release();
    w.release();
    await queue.idle();
  });
});
