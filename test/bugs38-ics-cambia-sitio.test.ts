import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bandejaCommand, icsAviso } from '../src/bandeja/comando.js';
import { BandejaQueue, processItem } from '../src/bandeja/procesar.js';
import { composeDigest, digestItems } from '../src/bandeja/resumen.js';
import { BandejaStore } from '../src/bandeja/store.js';
import { commandFromCallback } from '../src/channels/telegram-shared.js';
import { GOOGLE_KEYS } from '../src/google/oauth.js';
import { type EventoArgs, moverEvento, resetWorkspaceForTests } from '../src/google/workspace.js';

// bugs-38: una invitación .ics reenviada porque cambia el SITIO (Outlook manda otra versión con
// otra sala) decía «Ya está en tu calendario» si la hora era la misma, y si cambiaban hora y
// sitio, «✅ Sí, cámbialo» solo movía la hora (moverEvento hacía PATCH de start/end): el sitio
// viejo se quedaba en su Google Calendar.
const INV = (hora: string, lugar?: string) =>
  [
    'BEGIN:VCALENDAR',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'UID:junta-2026@empresa.es',
    `DTSTART;TZID=Europe/Madrid:20261120T${hora}00`,
    `DTEND;TZID=Europe/Madrid:20261120T${String(Number(hora.slice(0, 2)) + 1).padStart(2, '0')}${hora.slice(2)}00`,
    ...(lugar ? [`LOCATION:${lugar}`] : []),
    'SUMMARY:Junta de accionistas',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
const CHAT = '111';
const DAY = '2026-11-11';
const NOV11 = new Date('2026-11-11T15:00:00Z');
let dir = '';
let store: BandejaStore;
const prevTz = process.env.PA_TIMEZONE;
beforeEach(() => {
  resetWorkspaceForTests();
  process.env.PA_TIMEZONE = 'Europe/Madrid';
  dir = mkdtempSync(join(tmpdir(), 'pa-bugs38-ics-sitio-'));
  store = new BandejaStore(join(dir, 'bandeja.db'));
});
afterEach(() => {
  if (prevTz === undefined) delete process.env.PA_TIMEZONE;
  else process.env.PA_TIMEZONE = prevTz;
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
const procDeps = (ics: string) => ({
  complete: async () => {
    throw new Error('no debe llamar al modelo');
  },
  fetchRaw: async () => '',
  videoText: async () => ({ ok: false as const, reason: 'no' }),
  download: async () => Buffer.from(ics),
});
let n = 0;
async function ics(texto: string) {
  n++;
  const { item } = store.add(
    CHAT,
    { kind: 'texto', fileId: `F${n}`, mimeType: 'text/calendar', fileName: `i${n}.ics` },
    NOV11,
    DAY,
  );
  store.saveResult(item.id, await processItem(item, procDeps(texto) as never), NOV11);
  const it = store.get(item.id);
  if (!it) throw new Error('sin cosa');
  return it;
}
function deps(log: { creados: EventoArgs[]; movidos: Array<[string, EventoArgs]> }) {
  return {
    store,
    queue: new BandejaQueue(store, procDeps('') as never),
    chatId: CHAT,
    now: () => NOV11,
    timeZone: () => 'Europe/Madrid',
    calendario: async (a: EventoArgs) => {
      log.creados.push(a);
      return `📅 Apuntado en tu Google Calendar: «${a.titulo}». (id gev${log.creados.length})`;
    },
    moverCalendario: async (id: string, a: EventoArgs) => {
      log.movidos.push([id, a]);
      return '📅 Movido: «Junta de accionistas» ahora es vie 20 nov.';
    },
  };
}
const nuevoLog = () => ({
  creados: [] as EventoArgs[],
  movidos: [] as Array<[string, EventoArgs]>,
});

describe('bugs-38: invitación .ics que cambia de sitio', () => {
  it('misma hora, otro sitio: ofrece «✅ Sí, cámbialo» y lo cambia con el sitio nuevo', async () => {
    const log = nuevoLog();
    const d = deps(log);
    const v1 = await ics(INV('0930', 'Sede central'));
    await bandejaCommand(`apuntar ${v1.id}`, d);
    const v2 = await ics(INV('0930', 'IFEMA sala 3'));
    const aviso = await icsAviso(v2, d);
    expect(aviso?.text).toContain('cambia de sitio: ahora en IFEMA sala 3 (antes, Sede central)');
    expect(commandFromCallback(aviso?.buttons?.[0]?.action ?? '')).toBe(
      `/bandeja cambiar ${v2.id}`,
    );
    // El resumen tampoco lo da por apuntado: hay algo que cambiar.
    const dig = composeDigest(digestItems(store, CHAT, DAY), DAY, NOV11, store);
    expect(
      dig.buttons.some(
        (b) => commandFromCallback(b.action ?? '') === `/bandeja calendario ${v2.id}`,
      ),
    ).toBe(true);
    const r = await bandejaCommand(`cambiar ${v2.id}`, d);
    expect(r.text).toContain('📅 Cambiado en tu Google Calendar');
    expect(r.text).toContain('IFEMA sala 3');
    expect(log.movidos.map(([id, a]) => [id, a.lugar])).toEqual([['gev1', 'IFEMA sala 3']]);
    expect(log.creados).toHaveLength(1);
    expect((await bandejaCommand(`apuntar ${v2.id}`, d)).text).toContain(
      'ya está en tu calendario',
    );
  });

  it('otra hora y otro sitio: el cambio lleva los dos', async () => {
    const log = nuevoLog();
    const d = deps(log);
    const v1 = await ics(INV('0930', 'Sede central'));
    await bandejaCommand(`apuntar ${v1.id}`, d);
    const v2 = await ics(INV('1100', 'IFEMA sala 3'));
    await bandejaCommand(`cambiar ${v2.id}`, d);
    expect(log.movidos.map(([, a]) => [a.inicio, a.lugar])).toEqual([
      ['2026-11-20T11:00', 'IFEMA sala 3'],
    ]);
  });

  it('la nueva sin sitio y misma hora: «ya está» (no hay nada que cambiar)', async () => {
    const log = nuevoLog();
    const d = deps(log);
    const v1 = await ics(INV('0930', 'Sede central'));
    await bandejaCommand(`apuntar ${v1.id}`, d);
    const v2 = await ics(INV('0930'));
    expect((await bandejaCommand(`apuntar ${v2.id}`, d)).text).toContain(
      'Ya está en tu calendario',
    );
    expect(log.movidos).toHaveLength(0);
  });

  it('moverEvento manda también el sitio si lo hay', async () => {
    const calls: Array<{ method: string; body?: string }> = [];
    const m = new Map<string, string>([
      [GOOGLE_KEYS.clientId, 'cid.apps.googleusercontent.com'],
      [GOOGLE_KEYS.clientSecret, 'sec'],
      [GOOGLE_KEYS.scopes, 'https://www.googleapis.com/auth/calendar.events'],
      [GOOGLE_KEYS.refreshToken, 'RT'],
    ]);
    const vault = {
      get: async (k: string) => m.get(k),
      set: async (k: string, v: string) => void m.set(k, v),
      delete: async (k: string) => m.delete(k),
    };
    const f = (async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', body: init?.body as string });
      if (String(url).includes('oauth2.googleapis.com/token'))
        return new Response(JSON.stringify({ access_token: 'AT', expires_in: 3600 }));
      return new Response(
        JSON.stringify({ summary: 'Junta', start: { dateTime: '2026-11-20T11:00:00+01:00' } }),
      );
    }) as typeof fetch;
    await moverEvento(
      { vault, fetch: f, timeZone: () => 'Europe/Madrid' },
      { id: 'ev1', inicio: '2026-11-20T11:00', lugar: 'IFEMA sala 3' },
    );
    const p = calls.find((c) => c.method === 'PATCH');
    expect(JSON.parse(p?.body ?? '{}').location).toBe('IFEMA sala 3');
  });
});
