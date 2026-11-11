// bugs-36 (revisión de #2346 + #2359 «🔄 Releer la página»): la marca «ya apuntado» no
// guardaba la fecha. Si el congreso se movía y «Releer» traía la fecha nueva, «📅 Al
// calendario» contestaba «ya está en tu calendario: …, <fecha NUEVA>», pero en su Google
// Calendar seguía la vieja.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bandejaCommand } from '../src/bandeja/comando.js';
import { BandejaQueue, type ProcesarDeps, processItem } from '../src/bandeja/procesar.js';
import { BandejaStore } from '../src/bandeja/store.js';
import type { EventoArgs } from '../src/google/workspace.js';

const TZ = 'Europe/Madrid';
const CHAT = '111';
const NOV11 = new Date('2026-11-11T15:00:00Z');
const PARRAFO =
  'El mayor encuentro de inversores en valor de España vuelve a Madrid este año. '.repeat(40);
const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
const EVENTO = {
  '@context': 'https://schema.org',
  '@type': 'BusinessEvent',
  name: 'Value Investing Forum 2026',
  startDate: '2026-11-20T09:30:00+01:00',
  endDate: '2026-11-20T18:00:00+01:00',
  location: { '@type': 'Place', name: 'IFEMA' },
};
const HTML = `<html><head><title>VIF 2026</title>${ld(EVENTO)}</head><body><article><p>${PARRAFO}</p></article></body></html>`;
const REPLY =
  'TITULO: T\nVEREDICTO: IDEAS\nNOTA: 7\nMOTIVO: m\nIDEAS:\n- a\n- b\n- c\nETIQUETAS: ninguna';

let dir = '';
let store: BandejaStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-bugs36-cal-'));
  store = new BandejaStore(join(dir, 'bandeja.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const pdeps: ProcesarDeps = {
  complete: async () => async () => REPLY,
  fetchRaw: async () => HTML,
  videoText: async () => ({ ok: false, reason: 'no' }),
};

async function procesada() {
  const { item } = store.add(
    CHAT,
    { kind: 'enlace', url: 'https://vif.example/2026' },
    NOV11,
    '2026-11-11',
  );
  store.saveResult(item.id, await processItem(item, pdeps), NOV11);
  const fresh = store.get(item.id);
  if (!fresh?.extra.evento) throw new Error('sin evento');
  return fresh;
}

function cdeps(creados: EventoArgs[]) {
  return {
    store,
    queue: new BandejaQueue(store, pdeps),
    chatId: CHAT,
    now: () => NOV11,
    timeZone: () => TZ,
    calendario: async (a: EventoArgs) => {
      creados.push(a);
      return `📅 Apuntado en tu Google Calendar: «${a.titulo}»`;
    },
  };
}

describe('«📅 Al calendario» cuando el evento cambia de fecha', () => {
  it('con la misma fecha sigue diciendo «ya está»; con otra, avisa y deja apuntar la nueva', async () => {
    const item = await procesada();
    const creados: EventoArgs[] = [];
    const d = cdeps(creados);
    expect((await bandejaCommand(`apuntar ${item.id}`, d)).text).toContain('📅 Apuntado');
    expect((await bandejaCommand(`calendario ${item.id}`, d)).text).toContain(
      'ya está en tu calendario',
    );

    // «🔄 Releer la página»: el congreso pasa al 27.
    const ev = item.extra.evento;
    if (!ev) throw new Error('sin evento');
    store.setExtra(item.id, {
      ...item.extra,
      evento: { ...ev, inicio: '2026-11-27T09:30:00+01:00', fin: '2026-11-27T18:00:00+01:00' },
    });
    const pregunta = await bandejaCommand(`calendario ${item.id}`, d);
    expect(pregunta.text).not.toContain('ya está en tu calendario');
    expect(pregunta.text).toContain('⚠️ Lo apuntaste con otra fecha');
    expect(pregunta.text).toContain('20');
    expect(pregunta.text).toContain('27');
    expect(pregunta.buttons?.[0]?.label).toBe('✅ Sí, apúntalo');
    expect((await bandejaCommand(`apuntar ${item.id}`, d)).text).toContain('📅 Apuntado');
    expect(creados).toHaveLength(2);
    expect((await bandejaCommand(`calendario ${item.id}`, d)).text).toContain(
      'ya está en tu calendario',
    );
  });

  it('una marca antigua (sin fecha) sigue valiendo: no se apunta otra vez', async () => {
    const item = await procesada();
    store.setMeta(`cal_added_${item.id}`, '2026-11-11T15:05:00.000Z');
    const creados: EventoArgs[] = [];
    const r = await bandejaCommand(`apuntar ${item.id}`, cdeps(creados));
    expect(r.text).toContain('ya está en tu calendario');
    expect(creados).toHaveLength(0);
  });
});
