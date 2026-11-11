import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bandejaCommand } from '../src/bandeja/comando.js';
import { BandejaQueue, processItem } from '../src/bandeja/procesar.js';
import { composeDigest, digestItems } from '../src/bandeja/resumen.js';
import { BandejaStore } from '../src/bandeja/store.js';
import { commandFromCallback } from '../src/channels/telegram-shared.js';
import type { EventoArgs } from '../src/google/workspace.js';

// bugs-38: tras «✅ Sí, cámbialo» (la invitación .ics pasó de 09:30 a 11:00), la versión VIEJA
// seguía con «📅 N calendario» en el resumen, y tocarla ofrecía «¿Lo cambio?» de vuelta a las
// 09:30: un toque devolvía el evento a la hora que ya no vale.
const INV = (hora: string, seq: number) =>
  [
    'BEGIN:VCALENDAR',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'UID:junta-2026@empresa.es',
    `SEQUENCE:${seq}`,
    `DTSTART;TZID=Europe/Madrid:20261120T${hora}00`,
    `DTEND;TZID=Europe/Madrid:20261120T${String(Number(hora.slice(0, 2)) + 1).padStart(2, '0')}${hora.slice(2)}00`,
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
  process.env.PA_TIMEZONE = 'Europe/Madrid';
  dir = mkdtempSync(join(tmpdir(), 'pa-bugs38-ics-vieja-'));
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
const movidos: Array<[string, EventoArgs]> = [];
const deps = () => ({
  store,
  queue: new BandejaQueue(store, procDeps('') as never),
  chatId: CHAT,
  now: () => NOV11,
  timeZone: () => 'Europe/Madrid',
  calendario: async () => '📅 Apuntado en tu Google Calendar: «Junta de accionistas». (id gev1)',
  moverCalendario: async (id: string, a: EventoArgs) => {
    movidos.push([id, a]);
    return '📅 Movido: «Junta de accionistas».';
  },
});
const botonDe = (id: number) =>
  composeDigest(digestItems(store, CHAT, DAY), DAY, NOV11, store).buttons.some(
    (b) => commandFromCallback(b.action ?? '') === `/bandeja calendario ${id}`,
  );

describe('bugs-38: la versión vieja de una invitación ya cambiada', () => {
  it('sin «📅» en el resumen, y tocarla no devuelve el evento a la hora vieja', async () => {
    movidos.length = 0;
    const v1 = await ics(INV('0930', 0));
    await bandejaCommand(`apuntar ${v1.id}`, deps());
    const v2 = await ics(INV('1100', 1));
    await bandejaCommand(`cambiar ${v2.id}`, deps());
    expect(movidos).toHaveLength(1);
    expect(botonDe(v1.id)).toBe(false);
    expect(botonDe(v2.id)).toBe(false);
    for (const sub of ['calendario', 'apuntar', 'cambiar']) {
      const r = await bandejaCommand(`${sub} ${v1.id}`, deps());
      expect(r.text).toContain(`versión anterior`);
      expect(r.text).toContain(`#${v2.id}`);
      expect(r.buttons ?? []).toEqual([]);
    }
    expect(movidos).toHaveLength(1);
  });
});
