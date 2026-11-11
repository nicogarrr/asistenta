import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bandejaCommand, bandejaSlowSub, icsAviso } from '../src/bandeja/comando.js';
import { BandejaQueue, processItem } from '../src/bandeja/procesar.js';
import { BandejaStore } from '../src/bandeja/store.js';
import { commandFromCallback } from '../src/channels/telegram-shared.js';
import type { EventoArgs } from '../src/google/workspace.js';

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
const NOV11 = new Date('2026-11-11T15:00:00Z');
let dir = '';
let store: BandejaStore;
const prevTz = process.env.PA_TIMEZONE;
beforeEach(() => {
  process.env.PA_TIMEZONE = 'Europe/Madrid';
  dir = mkdtempSync(join(tmpdir(), 'pa-bugs37-ics-cambia-'));
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
    '2026-11-11',
  );
  store.saveResult(item.id, await processItem(item, procDeps(texto) as never), NOV11);
  const it = store.get(item.id);
  if (!it) throw new Error('sin cosa');
  return it;
}
function deps(
  log: { creados: EventoArgs[]; movidos: Array<[string, EventoArgs]> },
  mover?: string,
) {
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
      return mover ?? '📅 Movido: «Junta de accionistas» ahora es vie 20 nov 11:00.';
    },
  };
}

describe('bugs-37: una invitación .ics actualizada (otra hora) no crea un segundo evento', () => {
  it('ofrece «✅ Sí, cámbialo» y mueve el que se apuntó', async () => {
    const log = { creados: [] as EventoArgs[], movidos: [] as Array<[string, EventoArgs]> };
    const d = deps(log);
    const v1 = await ics(INV('0930', 0));
    await bandejaCommand(`apuntar ${v1.id}`, d);
    const v2 = await ics(INV('1100', 1));
    const aviso = await icsAviso(v2, d);
    expect(aviso?.text).toContain('cambia: ahora es viernes 20 nov, 11:00–12:00');
    expect(aviso?.text).toContain(`Lo apunté con la #${v1.id} para viernes 20 nov, 09:30–10:30`);
    const cmd = commandFromCallback(aviso?.buttons?.[0]?.action ?? '') ?? '';
    expect(cmd).toBe(`/bandeja cambiar ${v2.id}`);
    expect(bandejaSlowSub(cmd.replace('/bandeja ', ''))).toBe(true);
    // «✅ Sí, apúntalo» de la nueva tampoco crea otro: ofrece cambiarlo.
    expect((await bandejaCommand(`apuntar ${v2.id}`, d)).text).toContain('¿Lo cambio');
    expect(log.creados).toHaveLength(1);
    const r = await bandejaCommand(`cambiar ${v2.id}`, d);
    expect(r.text).toBe(
      '📅 Cambiado en tu Google Calendar: «Junta de accionistas», ahora viernes 20 nov, 11:00–12:00.',
    );
    expect(log.movidos.map(([id, a]) => [id, a.inicio])).toEqual([['gev1', '2026-11-20T11:00']]);
    // Ya cambiado: ni otro movimiento ni otro evento.
    expect((await bandejaCommand(`apuntar ${v2.id}`, d)).text).toContain(
      'ya está en tu calendario',
    );
    expect((await bandejaCommand(`cambiar ${v2.id}`, d)).text).toContain(
      'ya está en tu calendario',
    );
    expect(log.movidos).toHaveLength(1);
    expect(log.creados).toHaveLength(1);
  });

  it('la misma hora reenviada: «ya está», sin crear otro', async () => {
    const log = { creados: [] as EventoArgs[], movidos: [] as Array<[string, EventoArgs]> };
    const d = deps(log);
    const v1 = await ics(INV('0930', 0));
    await bandejaCommand(`apuntar ${v1.id}`, d);
    const v2 = await ics(INV('0930', 1).replace('SUMMARY', 'LOCATION:IFEMA\r\nSUMMARY'));
    expect((await bandejaCommand(`apuntar ${v2.id}`, d)).text).toContain(
      'Ya está en tu calendario',
    );
    expect(log.creados).toHaveLength(1);
  });

  it('si el de antes ya no está (lo borró él), ofrece apuntar el nuevo', async () => {
    const log = { creados: [] as EventoArgs[], movidos: [] as Array<[string, EventoArgs]> };
    const d = deps(log, 'Google dice que eso ya no existe (¿lo borraste?).');
    const v1 = await ics(INV('0930', 0));
    await bandejaCommand(`apuntar ${v1.id}`, d);
    const v2 = await ics(INV('1100', 1));
    const r = await bandejaCommand(`cambiar ${v2.id}`, d);
    expect(r.text).toContain('El de antes ya no está');
    expect(commandFromCallback(r.buttons?.[0]?.action ?? '')).toBe(`/bandeja apuntar ${v2.id}`);
    await bandejaCommand(`apuntar ${v2.id}`, d);
    expect(log.creados).toHaveLength(2);
  });
});
