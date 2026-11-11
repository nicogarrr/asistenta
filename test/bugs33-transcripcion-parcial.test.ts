import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { basisLine } from '../src/bandeja/formato.js';
import { deliverToKindle } from '../src/bandeja/kindle.js';
import { BandejaQueue, type ProcesarDeps } from '../src/bandeja/procesar.js';
import { BandejaStore } from '../src/bandeja/store.js';

// bugs-33 (11 nov 2026): un podcast de 2 h cuyo whisper se cortaba por tiempo (#2275,
// «solo los primeros 35 min») se juzgaba con esa parte… y nadie se lo decía a Nico: la
// ficha salía sin ⚠️, como si la nota fuera del episodio entero, y «📖 Al Kindle» le
// mandaba los primeros 35 min como si fuera la transcripción completa.

const CHAT = '111';
const NOV11 = new Date('2026-11-11T09:00:00Z');
const REPLY =
  'TITULO: T\nVEREDICTO: IDEAS\nNOTA: 7\nMOTIVO: m\nIDEAS:\n- a\n- b\n- c\nETIQUETAS: ninguna';
const TEXT = 'Esto es lo que se dijo en el episodio largo. '.repeat(80);

let dir: string;
let store: BandejaStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bugs33-parcial-'));
  store = new BandejaStore(join(dir, 'bandeja.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function unzip(buf: Buffer): string {
  let at = 0;
  let all = '';
  while (buf.readUInt32LE(at) === 0x04034b50) {
    const method = buf.readUInt16LE(at + 8);
    const size = buf.readUInt32LE(at + 18);
    const nameLen = buf.readUInt16LE(at + 26);
    const extra = buf.readUInt16LE(at + 28);
    const start = at + 30 + nameLen + extra;
    const raw = buf.subarray(start, start + size);
    all += (method === 0 ? raw : inflateRawSync(raw)).toString('utf8');
    at = start + size;
  }
  return all;
}

async function processed(capped?: number) {
  const deps: ProcesarDeps = {
    complete: async () => async () => REPLY,
    fetchRaw: async () => '',
    videoText: async () =>
      ({
        ok: true,
        text: TEXT,
        source: 'audio',
        meta: { title: 'Episodio largo', author: 'Programa', durationSeconds: 7200 },
        ...(capped ? { cappedAtMin: capped } : {}),
      }) as never,
  };
  const queue = new BandejaQueue(store, deps);
  const { item } = store.add(
    CHAT,
    { kind: 'youtube', url: 'https://www.youtube.com/watch?v=larguisimo' },
    NOV11,
    '2026-11-11',
  );
  await queue.enqueue(item.id);
  const done = store.get(item.id);
  if (!done) throw new Error('sin cosa');
  return done;
}

describe('bandeja: una transcripción cortada por tiempo se dice', () => {
  it('la ficha avisa de que solo se oyeron los primeros N min', async () => {
    const it1 = await processed(35);
    expect(it1.extra.heardMin).toBe(35);
    expect(basisLine(it1)).toMatch(/primeros 35 min/);
  });

  it('una transcripción entera no lleva aviso', async () => {
    const it1 = await processed();
    expect(it1.extra.heardMin).toBeUndefined();
    expect(basisLine(it1)).toBeNull();
  });

  it('el EPUB del Kindle dice que es parcial', async () => {
    const it1 = await processed(35);
    const sent: Buffer[] = [];
    await deliverToKindle(
      { item: it1 },
      {
        store,
        chatId: CHAT,
        fetchRaw: async () => '',
        convert: async () => ({ ok: false, reason: 'no-converter', message: 'sin calibre' }),
        sendFile: async (bytes) => {
          sent.push(bytes);
        },
        env: {},
        now: () => NOV11,
      },
    );
    expect(sent.length).toBeGreaterThan(0);
    expect(unzip(sent[0] as Buffer)).toMatch(/parcial: solo los primeros 35 min/);
  });
});
