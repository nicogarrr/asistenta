import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bandejaSlowSub } from '../src/bandeja/comando.js';
import { BandejaQueue, type ProcesarDeps } from '../src/bandeja/procesar.js';
import { BandejaStore } from '../src/bandeja/store.js';

// bugs-32 (11 nov 2026): Telegram reparte las actualizaciones de una en una (grammY espera a
// cada manejador). «⚡ Míralo ya» esperaba a que se transcribiera la cosa (hasta 15 min, y
// detrás de toda la cola) y «📖 Al Kindle» a bajar + EPUB + Calibre: mientras, no llegaba
// nada más al bot (ni otro mensaje, ni /stop, ni el botón de una aprobación).

const CHAT = '111';
const NOV11 = new Date('2026-11-11T09:00:00Z');
const REPLY =
  'TITULO: T\nVEREDICTO: IDEAS\nNOTA: 6\nMOTIVO: m\nIDEAS:\n- a\n- b\n- c\nETIQUETAS: ninguna';

let dir: string;
let store: BandejaStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bugs32-cola-'));
  store = new BandejaStore(join(dir, 'bandeja.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('bandeja: lo lento no para Telegram', () => {
  it('«ahora» y «kindle N|<enlace>» son lentas; los ajustes del Kindle y lo demás, no', () => {
    expect(bandejaSlowSub('ahora 12')).toBe(true);
    expect(bandejaSlowSub('ya 3')).toBe(true);
    expect(bandejaSlowSub('kindle 12')).toBe(true);
    expect(bandejaSlowSub('kindle 12 pdf')).toBe(true);
    expect(bandejaSlowSub('kindle https://fs.blog/x')).toBe(true);
    expect(bandejaSlowSub('kindle')).toBe(false);
    expect(bandejaSlowSub('kindle auto on')).toBe(false);
    expect(bandejaSlowSub('kindle correo nico@kindle.com')).toBe(false);
    expect(bandejaSlowSub('')).toBe(false);
    expect(bandejaSlowSub('visto 4')).toBe(false);
    expect(bandejaSlowSub('resumen')).toBe(false);
    expect(bandejaSlowSub('https://youtu.be/abc')).toBe(false);
  });

  it('el daemon corre /bandeja ahora y /kindle aparte (sin esperar dentro de la actualización)', () => {
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const at = src.indexOf('const cmdBandeja = async');
    expect(at).toBeGreaterThan(0);
    const body = src.slice(at, at + 1200);
    expect(body).toMatch(/if \(bandejaSlowSub\(args\)\) \{\s*void runBandejaCmd\(inbound, args\)/);
    // «/kindle N» y contestar «kindle» pasan por cmdBandeja → también aparte.
    expect(src).toMatch(/names: \['kindle'\], run: \(inbound, args\) => cmdBandeja\(/);
  });

  it('«⚡ Míralo ya» se pone delante de la cola (antes esperaba detrás de todo)', async () => {
    const ids = ['uno', 'dos', 'tres'].map(
      (t) =>
        store.add(CHAT, { kind: 'texto', title: t, note: `${t} `.repeat(40) }, NOV11, '2026-11-11')
          .item.id,
    );
    const order: number[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const deps: ProcesarDeps = {
      complete: async () => async () => {
        calls++;
        if (calls === 1) await gate;
        return REPLY;
      },
      fetchRaw: async () => '',
      videoText: async () => ({ ok: false, reason: 'no' }),
      onDone: (item) => {
        order.push(item.id);
      },
    };
    const queue = new BandejaQueue(store, deps);
    const [a, b, c] = ids as [number, number, number];
    void queue.enqueue(a);
    void queue.enqueue(b);
    const urgent = queue.enqueue(c, { first: true });
    await new Promise((r) => setTimeout(r, 20));
    release();
    await urgent;
    await queue.idle();
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual([a, c, b]);
  });

  it('pedirla «ya» dos veces no la mete dos veces', async () => {
    const id = store.add(
      CHAT,
      { kind: 'texto', title: 'x', note: 'x '.repeat(60) },
      NOV11,
      '2026-11-11',
    ).item.id;
    let runs = 0;
    const queue = new BandejaQueue(store, {
      complete: async () => async () => {
        runs++;
        return REPLY;
      },
      fetchRaw: async () => '',
      videoText: async () => ({ ok: false, reason: 'no' }),
    });
    await Promise.all([queue.enqueue(id, { first: true }), queue.enqueue(id, { first: true })]);
    expect(runs).toBe(1);
  });
});
