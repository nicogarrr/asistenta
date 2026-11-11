import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deliverToKindle, type KindleDeliverDeps } from '../src/bandeja/kindle.js';
import { oneAtATime } from '../src/bandeja/procesar.js';
import { type BandejaItem, BandejaStore } from '../src/bandeja/store.js';

// bugs-36 (lead de bugs-35, revisión de #2294): «📖 Al Kindle» de un vídeo sin su texto
// guardado lo transcribe en el turno del whisper que comparte con la cola de la bandeja.
// Tras «📖 Preparo #N…» el chat se quedaba callado hasta 35 min (esperando otro whisper y
// luego transcribiendo), sin decir por qué tardaba.

const CHAT = '111';
const NOV11 = new Date('2026-11-11T09:00:00Z');

let dir: string;
let store: BandejaStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bugs36-kindle-espera-'));
  store = new BandejaStore(join(dir, 'bandeja.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Un vídeo ya juzgado con su transcripción, pero sin el texto guardado (cosa vieja). */
function videoViejo(): BandejaItem {
  const { item } = store.add(
    CHAT,
    { kind: 'youtube', url: 'https://youtu.be/AAAAAAAAAAA' },
    NOV11,
    '2026-11-11',
  );
  store.saveResult(
    item.id,
    {
      verdict: 'imprescindible',
      score: 9,
      reason: 'r',
      ideas: [],
      costMin: 90,
      costLabel: '🎬 90 min',
      extra: { basis: 'transcripcion', source: 'YouTube' },
    },
    NOV11,
  );
  return store.get(item.id) as BandejaItem;
}

function deps(over: Partial<KindleDeliverDeps>) {
  const avisos: string[] = [];
  const d: KindleDeliverDeps = {
    store,
    chatId: CHAT,
    fetchRaw: async () => '',
    convert: async () => ({ ok: false, reason: 'no-converter', message: 'sin calibre' }),
    sendFile: async () => {},
    readable: async () => ({ title: 'Buffett', text: 'El foso del castillo importa.', extra: {} }),
    notify: async (text) => {
      avisos.push(text);
    },
    env: {},
    now: () => NOV11,
    ...over,
  };
  return { d, avisos };
}

describe('«📖 Al Kindle» avisa mientras espera una transcripción', () => {
  it('con el whisper ocupado por la cola, lo dice antes de esperar', async () => {
    const { d, avisos } = deps({ transcribeBusy: () => true });
    await deliverToKindle({ item: videoViejo() }, d);
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatch(/^⏳ .*transcribiendo otra cosa/);
  });

  it('con el whisper libre, dice que lo está transcribiendo', async () => {
    const { d, avisos } = deps({ transcribeBusy: () => false });
    await deliverToKindle({ item: videoViejo() }, d);
    expect(avisos).toEqual([expect.stringMatching(/^⏳ .*lo estoy transcribiendo/)]);
  });

  it('con el texto ya guardado no hay espera ni aviso', async () => {
    const item = videoViejo();
    store.saveText(item.id, 'El foso del castillo importa.');
    const { d, avisos } = deps({ transcribeBusy: () => true });
    await deliverToKindle({ item }, d);
    expect(avisos).toEqual([]);
  });

  it('el turno del whisper sabe si está ocupado', async () => {
    const slot = oneAtATime();
    expect(slot.busy?.()).toBe(false);
    let soltar: () => void = () => {};
    const dentro = slot(
      () =>
        new Promise<void>((r) => {
          soltar = r;
        }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(slot.busy?.()).toBe(true);
    soltar();
    await dentro;
    await new Promise((r) => setTimeout(r, 0));
    expect(slot.busy?.()).toBe(false);
  });
});
