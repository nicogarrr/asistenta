import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bandejaCommand, icsAviso } from '../src/bandeja/comando.js';
import { BandejaQueue, processItem } from '../src/bandeja/procesar.js';
import { composeDigest, digestItems } from '../src/bandeja/resumen.js';
import { BandejaStore } from '../src/bandeja/store.js';
import { commandFromCallback } from '../src/channels/telegram-shared.js';

// bugs-38: el resumen de la noche ofrecía «📅 N calendario» de una invitación que ya estaba
// apuntada (con «✅ Sí, apúntalo») o que se había cancelado. Al tocarlo lo decía bien («ya está
// en tu calendario» / «se canceló»), pero el botón sobraba.
const INV = (hora: string) =>
  [
    'BEGIN:VCALENDAR',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'UID:junta-2026@empresa.es',
    `DTSTART;TZID=Europe/Madrid:20261120T${hora}00`,
    `DTEND;TZID=Europe/Madrid:20261120T${String(Number(hora.slice(0, 2)) + 1).padStart(2, '0')}${hora.slice(2)}00`,
    'SUMMARY:Junta de accionistas',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
const CANCEL = INV('0930').replace('METHOD:REQUEST', 'METHOD:CANCEL');
const CHAT = '111';
const DAY = '2026-11-11';
const NOV11 = new Date('2026-11-11T15:00:00Z');
let dir = '';
let store: BandejaStore;
const prevTz = process.env.PA_TIMEZONE;
beforeEach(() => {
  process.env.PA_TIMEZONE = 'Europe/Madrid';
  dir = mkdtempSync(join(tmpdir(), 'pa-bugs38-digest-cal-'));
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
const deps = () => ({
  store,
  queue: new BandejaQueue(store, procDeps('') as never),
  chatId: CHAT,
  now: () => NOV11,
  timeZone: () => 'Europe/Madrid',
  calendario: async () => '📅 Apuntado en tu Google Calendar: «Junta de accionistas». (id gev1)',
  moverCalendario: async () => '📅 Movido.',
});
const calendarioDe = (id: number) => {
  const d = composeDigest(digestItems(store, CHAT, DAY), DAY, NOV11, store);
  return d.buttons.some((b) => commandFromCallback(b.action ?? '') === `/bandeja calendario ${id}`);
};

describe('bugs-38: «📅 N calendario» del resumen solo si aún hay algo que apuntar', () => {
  it('sin apuntar sale; apuntada ya no', async () => {
    const v1 = await ics(INV('0930'));
    expect(calendarioDe(v1.id)).toBe(true);
    await bandejaCommand(`apuntar ${v1.id}`, deps());
    expect(calendarioDe(v1.id)).toBe(false);
  });

  it('cancelada ya no sale (aunque no se apuntara)', async () => {
    const v1 = await ics(INV('0930'));
    const c = await ics(CANCEL);
    await icsAviso(c, deps());
    expect(calendarioDe(v1.id)).toBe(false);
  });

  it('la misma invitación reenviada con la misma hora no sale; con otra hora sí (ofrece cambiarla)', async () => {
    const v1 = await ics(INV('0930'));
    await bandejaCommand(`apuntar ${v1.id}`, deps());
    const igual = await ics(INV('0930'));
    const otra = await ics(INV('1100'));
    expect(calendarioDe(igual.id)).toBe(false);
    expect(calendarioDe(otra.id)).toBe(true);
  });

  it('sin el store (llamada vieja) se comporta como antes', async () => {
    const v1 = await ics(INV('0930'));
    await bandejaCommand(`apuntar ${v1.id}`, deps());
    const d = composeDigest(digestItems(store, CHAT, DAY), DAY, NOV11);
    expect(
      d.buttons.some((b) => commandFromCallback(b.action ?? '') === `/bandeja calendario ${v1.id}`),
    ).toBe(true);
  });
});
