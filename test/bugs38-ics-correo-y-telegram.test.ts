import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bandejaCommand } from '../src/bandeja/comando.js';
import { BandejaQueue, processItem } from '../src/bandeja/procesar.js';
import { BandejaStore } from '../src/bandeja/store.js';
import { commandFromCallback } from '../src/channels/telegram-shared.js';
import type { EventoArgs } from '../src/google/workspace.js';
import {
  apuntarSiEnBandeja,
  type InvitacionCorreo,
  InvitacionesCorreo,
} from '../src/mail/invitacion-aviso.js';

// bugs-38: la misma invitación (mismo UID) por correo y por Telegram creaba dos eventos: la
// tarjeta del correo y la bandeja no sabían la una de la otra.
const UID = 'junta-2026@empresa.es';
const INV = (hora: string) =>
  [
    'BEGIN:VCALENDAR',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${UID}`,
    `DTSTART;TZID=Europe/Madrid:20261120T${hora}00`,
    `DTEND;TZID=Europe/Madrid:20261120T${String(Number(hora.slice(0, 2)) + 1).padStart(2, '0')}${hora.slice(2)}00`,
    'SUMMARY:Junta de accionistas',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
const CHAT = '111';
const NOV11 = new Date('2026-11-11T15:00:00Z');
const TZ = 'Europe/Madrid';
let dir = '';
let store: BandejaStore;
const prevTz = process.env.PA_TIMEZONE;
beforeEach(() => {
  process.env.PA_TIMEZONE = TZ;
  dir = mkdtempSync(join(tmpdir(), 'pa-bugs38-ics-correo-'));
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
type Log = { creados: EventoArgs[]; movidos: Array<[string, EventoArgs]>; olvidadas: number };
const nuevoLog = (): Log => ({ creados: [], movidos: [], olvidadas: 0 });
function deps(log: Log, correo: { gid: string; args: EventoArgs } | null) {
  return {
    store,
    queue: new BandejaQueue(store, procDeps('') as never),
    chatId: CHAT,
    now: () => NOV11,
    timeZone: () => TZ,
    calendario: async (a: EventoArgs) => {
      log.creados.push(a);
      return `📅 Apuntado en tu Google Calendar: «${a.titulo}». (id gev${log.creados.length})`;
    },
    moverCalendario: async (id: string, a: EventoArgs) => {
      log.movidos.push([id, a]);
      return '📅 Movido: «Junta de accionistas» ahora es vie 20 nov.';
    },
    invitacionCorreo: async (uid: string) =>
      uid === UID && correo ? { ...correo, olvidar: () => void log.olvidadas++ } : null,
  };
}
const correo = (inicio: string, fin: string) => ({
  gid: 'gmail1',
  args: { titulo: 'Junta de accionistas', inicio, fin },
});
const invCorreo = (inicio: string, fin: string): InvitacionCorreo => ({
  clave: 'c1',
  titulo: 'Junta de accionistas',
  inicio,
  fin,
  de: 'Ana <ana@empresa.es>',
  asunto: 'Junta',
  avisada: NOV11.getTime(),
  uid: UID,
});

describe('bugs-38: la misma invitación por correo y por Telegram no crea dos eventos', () => {
  it('.ics por Telegram de una ya apuntada con la tarjeta del correo: «ya está», sin crear', async () => {
    const log = nuevoLog();
    const v = await ics(INV('0930'));
    const r = await bandejaCommand(
      `apuntar ${v.id}`,
      deps(log, correo('2026-11-20T09:30', '2026-11-20T10:30')),
    );
    expect(r.text).toContain('Ya está en tu calendario (lo apunté con la invitación del correo)');
    expect(log.creados).toHaveLength(0);
  });

  it('… con otra hora: ofrece «✅ Sí, cámbialo» y mueve el del correo', async () => {
    const log = nuevoLog();
    const d = deps(log, correo('2026-11-20T09:30', '2026-11-20T10:30'));
    const v = await ics(INV('1100'));
    const r = await bandejaCommand(`apuntar ${v.id}`, d);
    expect(r.text).toContain(
      'Lo apunté con la invitación del correo para viernes 20 nov, 09:30–10:30',
    );
    expect(commandFromCallback(r.buttons?.[0]?.action ?? '')).toBe(`/bandeja cambiar ${v.id}`);
    expect((await bandejaCommand(`cambiar ${v.id}`, d)).text).toContain('📅 Cambiado');
    expect(log.movidos.map(([id, a]) => [id, a.inicio])).toEqual([['gmail1', '2026-11-20T11:00']]);
    expect(log.creados).toHaveLength(0);
    expect(log.olvidadas).toBe(0);
    // Desde entonces es de la bandeja: «apuntar» otra vez dice «ya está».
    expect((await bandejaCommand(`apuntar ${v.id}`, d)).text).toContain('ya está en tu calendario');
  });

  it('tarjeta del correo de una ya apuntada por la bandeja: «ya está» o la mueve', async () => {
    const log = nuevoLog();
    const v = await ics(INV('0930'));
    await bandejaCommand(`apuntar ${v.id}`, deps(log, null));
    expect(log.creados).toHaveLength(1);
    const movidos: Array<[string, EventoArgs]> = [];
    const mover = async (gid: string, a: EventoArgs) => {
      movidos.push([gid, a]);
      return '📅 Movido: «Junta de accionistas».';
    };
    const igual = await apuntarSiEnBandeja(
      invCorreo('2026-11-20T09:30', '2026-11-20T10:30'),
      store,
      CHAT,
      TZ,
      mover,
    );
    expect(igual).toEqual({
      text: `📅 «Junta de accionistas» ya está en tu Google Calendar (la apunté con la #${v.id} de la bandeja).`,
      gid: 'gev1',
    });
    const otra = await apuntarSiEnBandeja(
      invCorreo('2026-11-20T11:00', '2026-11-20T12:00'),
      store,
      CHAT,
      TZ,
      mover,
    );
    expect(otra?.gid).toBe('gev1');
    expect(otra?.text).toContain('📅 Cambiada en tu Google Calendar');
    expect(movidos.map(([g, a]) => [g, a.inicio])).toEqual([['gev1', '2026-11-20T11:00']]);
    // Otro chat, o sin UID: nada que ver (se crea como siempre).
    expect(
      await apuntarSiEnBandeja(invCorreo('2026-11-20T09:30', ''), store, '222', TZ, mover),
    ).toBeNull();
    const { uid: _u, ...sinUid } = invCorreo('2026-11-20T09:30', '2026-11-20T10:30');
    expect(await apuntarSiEnBandeja(sinUid, store, CHAT, TZ, mover)).toBeNull();
  });

  it('InvitacionesCorreo.apuntadaPorUid: solo la apuntada con id de Google', () => {
    const s = new InvitacionesCorreo(join(dir, 'inv.json'));
    const inv = invCorreo('2026-11-20T09:30', '2026-11-20T10:30');
    s.nuevas([inv], TZ, NOV11);
    expect(s.apuntadaPorUid(UID)).toBeNull();
    s.marcarApuntada(inv.clave, 'gmail1');
    expect(s.apuntadaPorUid(UID)?.gid).toBe('gmail1');
    expect(s.apuntadaPorUid('otro@x')).toBeNull();
  });
});
