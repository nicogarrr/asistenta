import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bandejaCommand, bandejaSlowSub, icsAviso } from '../src/bandeja/comando.js';
import { BandejaQueue, processItem } from '../src/bandeja/procesar.js';
import { BandejaStore } from '../src/bandeja/store.js';
import { commandFromCallback } from '../src/channels/telegram-shared.js';
import type { EventoArgs } from '../src/google/workspace.js';

const INVITE = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'METHOD:REQUEST',
  'BEGIN:VEVENT',
  'UID:abc123@google.com',
  'DTSTART;TZID=Europe/Madrid:20261120T093000',
  'DTEND;TZID=Europe/Madrid:20261120T103000',
  'SUMMARY:Junta de accionistas',
  'LOCATION:IFEMA',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');
const CANCEL = INVITE.replace('METHOD:REQUEST', 'METHOD:CANCEL');
const CHAT = '111';
const NOV11 = new Date('2026-11-11T15:00:00Z');

let dir = '';
let store: BandejaStore;
const prevTz = process.env.PA_TIMEZONE;
beforeEach(() => {
  process.env.PA_TIMEZONE = 'Europe/Madrid';
  dir = mkdtempSync(join(tmpdir(), 'pa-bugs37-ics-cancel-'));
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

async function ics(texto: string, n: number) {
  const { item } = store.add(
    CHAT,
    { kind: 'texto', fileId: `F${n}`, mimeType: 'text/calendar', fileName: `i${n}.ics` },
    NOV11,
    '2026-11-11',
  );
  store.saveResult(item.id, await processItem(item, procDeps(texto) as never), NOV11);
  const it = store.get(item.id);
  if (!it) throw new Error('sin cosa');
  return it;
}

function deps(log: { creados: EventoArgs[]; borrados: string[] }) {
  return {
    store,
    queue: new BandejaQueue(store, procDeps('') as never),
    chatId: CHAT,
    now: () => NOV11,
    timeZone: () => 'Europe/Madrid',
    calendario: async (a: EventoArgs) => {
      log.creados.push(a);
      return `📅 Apuntado en tu Google Calendar: «${a.titulo}», vie 20 nov 09:30. (id gev${log.creados.length})`;
    },
    quitarCalendario: async (id: string) => {
      log.borrados.push(id);
      return '🗑️ Borrado de tu Google Calendar.';
    },
  };
}

describe('bugs-37: la cancelación .ics de algo apuntado ofrece quitarlo', () => {
  it('apuntada con «✅ Sí» → la cancelación pregunta «¿lo quito?» y «🗑️ Sí, quítalo» lo borra', async () => {
    const log = { creados: [] as EventoArgs[], borrados: [] as string[] };
    const d = deps(log);
    const inv = await ics(INVITE, 1);
    expect((await bandejaCommand(`apuntar ${inv.id}`, d)).text).toMatch(/^📅 Apuntado/);
    const cancel = await ics(CANCEL, 2);
    const aviso = await icsAviso(cancel, d);
    expect(aviso?.text).toContain('Se cancela «Junta de accionistas»');
    expect(aviso?.text).toContain(`¿lo quito?`);
    const cmd = commandFromCallback(aviso?.buttons?.[0]?.action ?? '') ?? '';
    expect(cmd).toBe(`/bandeja desapuntar ${inv.id}`);
    expect(bandejaSlowSub(cmd.replace('/bandeja ', ''))).toBe(true);
    // Hasta que lo toca, no se borra nada.
    expect(log.borrados).toEqual([]);
    const r = await bandejaCommand(`desapuntar ${inv.id}`, d);
    expect(r.text).toMatch(/^🗑️ Quitado de tu Google Calendar: «Junta de accionistas», /);
    expect(log.borrados).toEqual(['gev1']);
    // Un segundo toque no borra otra cosa.
    expect((await bandejaCommand(`desapuntar ${inv.id}`, d)).text).toContain(
      'no lo tengo apuntado',
    );
    expect(log.borrados).toEqual(['gev1']);
  });

  it('tras la cancelación, «✅ Sí, apúntalo» de la invitación ya no la apunta', async () => {
    const log = { creados: [] as EventoArgs[], borrados: [] as string[] };
    const d = deps(log);
    const inv = await ics(INVITE, 1);
    await icsAviso(await ics(CANCEL, 2), d);
    const r = await bandejaCommand(`apuntar ${inv.id}`, d);
    expect(r.text).toContain('se canceló');
    expect(log.creados).toEqual([]);
  });

  it('sin apuntar antes, la cancelación solo lo dice (sin botón para borrar)', async () => {
    const d = deps({ creados: [], borrados: [] });
    await ics(INVITE, 1);
    const aviso = await icsAviso(await ics(CANCEL, 2), d);
    expect(aviso?.text).toMatch(/^❌ #\d+ Es la cancelación de «Junta de accionistas»/);
    expect(aviso?.buttons ?? []).toEqual([]);
  });

  it('si ya lo había borrado él (Google: 410), lo dice y lo olvida', async () => {
    const log = { creados: [] as EventoArgs[], borrados: [] as string[] };
    const d = {
      ...deps(log),
      quitarCalendario: async () => 'Google ha respondido 410. Prueba en un rato.',
    };
    const inv = await ics(INVITE, 1);
    await bandejaCommand(`apuntar ${inv.id}`, d);
    expect((await bandejaCommand(`desapuntar ${inv.id}`, d)).text).toBe(
      '🗑️ «Junta de accionistas» ya no estaba en tu Google Calendar.',
    );
  });
});
