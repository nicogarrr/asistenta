import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bandejaCommand, bandejaSlowSub } from '../src/bandeja/comando.js';
import {
  cuandoTexto,
  eventFromHtml,
  eventoArgs,
  localWallTime,
  yaPaso,
} from '../src/bandeja/evento.js';
import { calendarioButton, cardButtons } from '../src/bandeja/formato.js';
import { BandejaQueue, type ProcesarDeps, processItem } from '../src/bandeja/procesar.js';
import { BandejaStore } from '../src/bandeja/store.js';
import { commandFromCallback } from '../src/channels/telegram-shared.js';
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
  dir = mkdtempSync(join(tmpdir(), 'pa-gaps13-bandeja-cal-'));
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

describe('gaps-13: la ficha schema.org Event de una página', () => {
  it('lee nombre, fechas y lugar (también dentro de @graph y con subtipos de Event)', () => {
    expect(eventFromHtml(HTML)).toEqual({
      nombre: 'Value Investing Forum 2026',
      inicio: '2026-11-20T09:30:00+01:00',
      fin: '2026-11-20T18:00:00+01:00',
      lugar: 'IFEMA, Av. del Partenón 5, Madrid',
    });
    const online = eventFromHtml(
      ld({
        '@type': 'Event',
        name: 'Webinar',
        startDate: '2026-12-01T17:00:00Z',
        location: { '@type': 'VirtualLocation', url: 'https://zoom.example/x' },
      }),
    );
    expect(online?.lugar).toBe('En línea: https://zoom.example/x');
  });

  it('sin fecha, cancelado o sin ficha: nada', () => {
    expect(eventFromHtml(ld({ '@type': 'Event', name: 'X' }))).toBeNull();
    expect(
      eventFromHtml(
        ld({
          '@type': 'Event',
          name: 'X',
          startDate: '2026-12-01',
          eventStatus: 'https://schema.org/EventCancelled',
        }),
      ),
    ).toBeNull();
    expect(eventFromHtml(ld({ '@type': 'Recipe', name: 'Tortilla' }))).toBeNull();
    expect(eventFromHtml('<html><body>nada</body></html>')).toBeNull();
  });

  it('pasa las horas a la suya (también en el cambio de hora) y el día entero con fin exclusivo', () => {
    expect(localWallTime('2026-11-20T08:30:00Z', TZ)).toBe('2026-11-20T09:30');
    expect(localWallTime('2026-07-01T08:30:00Z', TZ)).toBe('2026-07-01T10:30');
    expect(localWallTime('2026-11-20T09:30', TZ)).toBe('2026-11-20T09:30');
    const a = eventoArgs({ nombre: 'Feria', inicio: '2026-11-20', fin: '2026-11-22' }, TZ, null);
    expect(a).toEqual({ titulo: 'Feria', inicio: '2026-11-20', fin: '2026-11-23' });
    expect(cuandoTexto(a)).toBe('del viernes 20 nov al 22/11 (todo el día)');
    // Un fin que no cuadra (antes del inicio) se ignora: crearEvento pone una hora.
    expect(
      eventoArgs({ nombre: 'X', inicio: '2026-11-20T10:00', fin: '2026-11-20T09:00' }, TZ, null)
        .fin,
    ).toBeUndefined();
  });

  it('sabe si ya pasó', () => {
    const a: EventoArgs = { inicio: '2026-11-20T09:30', fin: '2026-11-20T18:00' };
    expect(yaPaso(a, '2026-11-20T17:59')).toBe(false);
    expect(yaPaso(a, '2026-11-20T18:00')).toBe(true);
    expect(yaPaso({ inicio: '2026-11-20' }, '2026-11-20T23:00')).toBe(false);
    expect(yaPaso({ inicio: '2026-11-20' }, '2026-11-21T00:01')).toBe(true);
  });
});

describe('gaps-13: «📅 Al calendario» en la ficha de la bandeja', () => {
  it('un enlace con evento lleva el botón; enseña qué apuntaría antes de apuntar nada', async () => {
    const item = await procesada(HTML);
    expect(item.extra.evento?.nombre).toBe('Value Investing Forum 2026');
    const b = calendarioButton(item);
    expect(cardButtons(item).map((x) => x.label)).toContain('📅 Al calendario');
    expect(commandFromCallback(b?.action ?? '')).toBe(`/bandeja calendario ${item.id}`);
    expect(bandejaSlowSub(`calendario ${item.id}`)).toBe(false);
    expect(bandejaSlowSub(`apuntar ${item.id}`)).toBe(true);

    const creados: EventoArgs[] = [];
    const cdeps = {
      store,
      queue: new BandejaQueue(store, deps(HTML)),
      chatId: CHAT,
      now: () => NOV11,
      timeZone: () => TZ,
      calendario: async (a: EventoArgs) => {
        creados.push(a);
        return `📅 Apuntado en tu Google Calendar: «${a.titulo}», …`;
      },
    };
    const preview = await bandejaCommand(`calendario ${item.id}`, cdeps);
    expect(creados).toEqual([]);
    expect(preview.text).toContain('¿Lo apunto en tu Google Calendar?');
    expect(preview.text).toContain('🗓️ viernes 20 nov, 09:30–18:00');
    expect(preview.text).toContain('📍 IFEMA');
    expect(commandFromCallback(preview.buttons?.[0]?.action ?? '')).toBe(
      `/bandeja apuntar ${item.id}`,
    );

    const ok = await bandejaCommand(`apuntar ${item.id}`, cdeps);
    expect(ok.text).toContain('📅 Apuntado');
    expect(creados).toEqual([
      {
        titulo: 'Value Investing Forum 2026',
        inicio: '2026-11-20T09:30',
        fin: '2026-11-20T18:00',
        lugar: 'IFEMA, Av. del Partenón 5, Madrid',
        descripcion: 'Guardado desde la bandeja: https://vif.example/2026',
      },
    ]);
    // Un segundo toque no lo apunta dos veces.
    const again = await bandejaCommand(`apuntar ${item.id}`, cdeps);
    expect(again.text).toContain('ya está en tu calendario');
    expect(creados).toHaveLength(1);
  });

  it('sin Google conectado no marca nada (el siguiente toque lo reintenta); lo pasado no se apunta', async () => {
    const item = await procesada(HTML);
    let n = 0;
    const base = {
      store,
      queue: new BandejaQueue(store, deps(HTML)),
      chatId: CHAT,
      timeZone: () => TZ,
      calendario: async () => {
        n++;
        return 'Google no está conectado. Escribe /google conectar.';
      },
    };
    await bandejaCommand(`apuntar ${item.id}`, { ...base, now: () => NOV11 });
    await bandejaCommand(`apuntar ${item.id}`, { ...base, now: () => NOV11 });
    expect(n).toBe(2);
    const tarde = await bandejaCommand(`calendario ${item.id}`, {
      ...base,
      now: () => new Date('2026-11-21T10:00:00Z'),
    });
    expect(tarde.text).toContain('ya pasó');
    expect(tarde.buttons).toBeUndefined();
  });

  it('una página sin evento no lleva el botón, y otro chat no toca nada', async () => {
    const item = await procesada(`<html><body><article><p>${PARRAFO}</p></article></body></html>`);
    expect(item.extra.evento).toBeUndefined();
    expect(calendarioButton(item)).toBeUndefined();
    const conEvento = await procesada(HTML);
    const r = await bandejaCommand(`apuntar ${conEvento.id}`, {
      store,
      queue: new BandejaQueue(store, deps(HTML)),
      chatId: '999',
      now: () => NOV11,
      calendario: async () => {
        throw new Error('no debería');
      },
    });
    expect(r.text).toContain('No tengo la');
  });
});
