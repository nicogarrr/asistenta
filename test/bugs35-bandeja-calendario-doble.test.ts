// bugs-35 (revisión de #2346): «✅ Sí, apúntalo» es una orden lenta (bandejaSlowSub: va
// aparte, sin esperar), así que dos toques seguidos corrían a la vez. Los dos veían «no
// apuntado» antes de que el primero terminara y creaban DOS eventos en su Google Calendar.
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
  location: {
    '@type': 'Place',
    name: 'IFEMA',
    address: { streetAddress: 'Av. del Partenón 5', addressLocality: 'Madrid' },
  },
};
const HTML = `<html><head><title>VIF 2026</title>${ld({ '@graph': [{ '@type': 'WebPage' }, EVENTO] })}</head><body><article><p>${PARRAFO}</p></article></body></html>`;
const REPLY =
  'TITULO: T\nVEREDICTO: IDEAS\nNOTA: 7\nMOTIVO: m\nIDEAS:\n- a\n- b\n- c\nETIQUETAS: ninguna';

let dir = '';
let store: BandejaStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-bugs35-cal-'));
  store = new BandejaStore(join(dir, 'bandeja.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const deps = (html: string): ProcesarDeps => ({
  complete: async () => async () => REPLY,
  fetchRaw: async () => html,
  videoText: async () => ({ ok: false, reason: 'no' }),
});

async function procesada(html: string) {
  const { item } = store.add(
    CHAT,
    { kind: 'enlace', url: 'https://vif.example/2026' },
    NOV11,
    '2026-11-11',
  );
  const r = await processItem(item, deps(html));
  store.saveResult(item.id, r, NOV11);
  const fresh = store.get(item.id);
  if (!fresh) throw new Error('sin cosa');
  return fresh;
}

describe('«📅 Al calendario»: dos toques seguidos', () => {
  it('apunta el evento una sola vez aunque el segundo llegue mientras el primero crea', async () => {
    const item = await procesada(HTML);
    const creados: EventoArgs[] = [];
    let soltar: () => void = () => undefined;
    const lento = new Promise<void>((r) => {
      soltar = r;
    });
    const cdeps = {
      store,
      queue: new BandejaQueue(store, deps(HTML)),
      chatId: CHAT,
      now: () => NOV11,
      timeZone: () => TZ,
      calendario: async (a: EventoArgs) => {
        creados.push(a);
        await lento;
        return `📅 Apuntado en tu Google Calendar: «${a.titulo}», …`;
      },
    };
    const uno = bandejaCommand(`apuntar ${item.id}`, cdeps);
    await new Promise((r) => setTimeout(r, 5));
    const dos = bandejaCommand(`apuntar ${item.id}`, cdeps);
    await new Promise((r) => setTimeout(r, 5));
    soltar();
    const [r1, r2] = await Promise.all([uno, dos]);
    expect(creados).toHaveLength(1);
    expect(r1.text).toContain('📅 Apuntado');
    expect(r2.text).toContain('Ya lo estoy apuntando');
  });

  it('si el primero no lo apunta, el siguiente toque vuelve a intentarlo', async () => {
    const item = await procesada(HTML);
    let n = 0;
    const cdeps = {
      store,
      queue: new BandejaQueue(store, deps(HTML)),
      chatId: CHAT,
      now: () => NOV11,
      timeZone: () => TZ,
      calendario: async () => {
        n++;
        if (n === 1) throw new Error('red caída');
        return '📅 Apuntado en tu Google Calendar: «x»';
      },
    };
    await expect(bandejaCommand(`apuntar ${item.id}`, cdeps)).rejects.toThrow('red caída');
    expect((await bandejaCommand(`apuntar ${item.id}`, cdeps)).text).toContain('📅 Apuntado');
    expect(n).toBe(2);
  });
});
