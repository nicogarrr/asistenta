import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { icsAviso } from '../src/bandeja/comando.js';
import { cardText } from '../src/bandeja/formato.js';
import { BandejaQueue, processItem } from '../src/bandeja/procesar.js';
import { BandejaStore } from '../src/bandeja/store.js';
import { commandFromCallback } from '../src/channels/telegram-shared.js';
import { fechaIcs, ianaDe, invitacionLineas, isIcsFile, parseIcs } from '../src/ics.js';
import { toMessage } from '../src/mail/client.js';
import { calendarPartsOf } from '../src/mail/mime.js';

const GOOGLE = [
  'BEGIN:VCALENDAR',
  'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
  'VERSION:2.0',
  'METHOD:REQUEST',
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Madrid',
  'BEGIN:STANDARD',
  'DTSTART:19701025T030000',
  'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'DTSTART;TZID=Europe/Madrid:20261120T093000',
  'DTEND;TZID=Europe/Madrid:20261120T103000',
  'SUMMARY:Junta de accionistas\\, Q4',
  'LOCATION:IFEMA\\, Madrid',
  'DESCRIPTION:Orden del día:\\n1. Cuentas',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'DESCRIPTION:This is an event reminder',
  'TRIGGER:-P0DT0H30M0S',
  'END:VALARM',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

let dir = '';
let store: BandejaStore;
const prevTz = process.env.PA_TIMEZONE;
beforeEach(() => {
  process.env.PA_TIMEZONE = 'Europe/Madrid';
  dir = mkdtempSync(join(tmpdir(), 'pa-gaps15-ics-'));
  store = new BandejaStore(join(dir, 'bandeja.db'));
});
afterEach(() => {
  if (prevTz === undefined) delete process.env.PA_TIMEZONE;
  else process.env.PA_TIMEZONE = prevTz;
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const NOV11 = new Date('2026-11-11T15:00:00Z');
const MAD = 'Europe/Madrid';

describe('gaps-15: invitaciones .ics leídas sin modelo', () => {
  it('Google: TZID, escapes, VALARM fuera, lugar', () => {
    const { metodo, eventos } = parseIcs(GOOGLE);
    expect(metodo).toBe('REQUEST');
    expect(eventos).toEqual([
      {
        nombre: 'Junta de accionistas, Q4',
        inicio: '2026-11-20T08:30:00Z',
        fin: '2026-11-20T09:30:00Z',
        lugar: 'IFEMA, Madrid',
      },
    ]);
    expect(invitacionLineas([GOOGLE], MAD, NOV11)).toEqual([
      '📅 Invitación: «Junta de accionistas, Q4» — viernes 20 nov, 09:30–10:30 · IFEMA, Madrid',
    ]);
  });

  it('fechas: UTC, flotante, día entero, Windows (Outlook) y verano/invierno', () => {
    const p = (o: Record<string, string> = {}) => new Map(Object.entries(o));
    expect(fechaIcs('20261120T083000Z', p())).toBe('2026-11-20T08:30:00Z');
    expect(fechaIcs('20261120T093000', p())).toBe('2026-11-20T09:30');
    expect(fechaIcs('20261120', p({ value: 'DATE' }))).toBe('2026-11-20');
    expect(fechaIcs('20261120T093000', p({ tzid: 'Romance Standard Time' }))).toBe(
      '2026-11-20T08:30:00Z',
    );
    // Julio en Madrid es UTC+2.
    expect(fechaIcs('20260715T093000', p({ tzid: '"Europe/Madrid"' }))).toBe(
      '2026-07-15T07:30:00Z',
    );
    expect(fechaIcs('20261120T093000', p({ tzid: 'Eastern Standard Time' }))).toBe(
      '2026-11-20T14:30:00Z',
    );
    expect(ianaDe('/mozilla.org/20070129_1/Europe/Madrid')).toBe('Europe/Madrid');
    expect(ianaDe('Zona/Inventada')).toBeNull();
    expect(fechaIcs('mañana', p())).toBeNull();
  });

  it('DURATION, día entero de varios días, repetición y cancelación', () => {
    const ev = (body: string, head = '') =>
      `BEGIN:VCALENDAR\r\n${head}BEGIN:VEVENT\r\n${body}\r\nEND:VEVENT\r\nEND:VCALENDAR`;
    expect(
      parseIcs(ev('DTSTART:20261120T083000Z\r\nDURATION:PT1H30M\r\nSUMMARY:Call')).eventos[0]?.fin,
    ).toBe('2026-11-20T10:00:00Z');
    const congreso = parseIcs(
      ev('DTSTART;VALUE=DATE:20261202\r\nDTEND;VALUE=DATE:20261204\r\nSUMMARY:South Summit'),
    ).eventos[0];
    // DTEND de día entero es exclusivo: el último día es el 3 (bugs-36).
    expect(congreso).toMatchObject({ inicio: '2026-12-02', fin: '2026-12-03' });
    expect(
      parseIcs(ev('DTSTART:20261120T083000Z\r\nRRULE:FREQ=WEEKLY\r\nSUMMARY:Pádel')).eventos[0]
        ?.repite,
    ).toBe(true);
    const cancel = ev('DTSTART:20261120T083000Z\r\nSUMMARY:Comida', 'METHOD:CANCEL\r\n');
    expect(parseIcs(cancel).eventos[0]?.cancelado).toBe(true);
    expect(invitacionLineas([cancel], MAD, NOV11)[0]).toMatch(
      /^❌ Cancela: «Comida» — viernes 20 nov, 09:30/,
    );
    // Las líneas plegadas (RFC 5545 §3.1) se unen.
    expect(
      parseIcs(ev('DTSTART:20261120T083000Z\r\nSUMMARY:Reunión con el equipo de\r\n  inversión'))
        .eventos[0]?.nombre,
    ).toBe('Reunión con el equipo de inversión');
    expect(parseIcs('hola').eventos).toEqual([]);
    expect(parseIcs(ev('SUMMARY:Sin fecha')).eventos).toEqual([]);
  });

  it('isIcsFile por tipo o por nombre', () => {
    expect(isIcsFile('text/calendar; method=REQUEST', null)).toBe(true);
    expect(isIcsFile('application/octet-stream', 'invite.ics')).toBe(true);
    expect(isIcsFile('application/pdf', 'factura.pdf')).toBe(false);
  });
});

describe('gaps-15: un correo con invitación la enseña (adjuntos no se leían)', () => {
  const b64 = Buffer.from(GOOGLE, 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n');
  const SOURCE = [
    'From: Ana <ana@empresa.example>',
    'Subject: Invitación: Junta',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="MIX"',
    '',
    '--MIX',
    'Content-Type: multipart/alternative; boundary="ALT"',
    '',
    '--ALT',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    'Te invito a la junta.',
    '--ALT',
    'Content-Type: text/calendar; charset=UTF-8; method=REQUEST',
    'Content-Transfer-Encoding: 7bit',
    '',
    GOOGLE,
    '--ALT--',
    '--MIX',
    'Content-Type: application/ics; name="invite.ics"',
    'Content-Disposition: attachment; filename="invite.ics"',
    'Content-Transfer-Encoding: base64',
    '',
    b64,
    '--MIX--',
    '',
  ].join('\r\n');

  it('calendarPartsOf saca la parte text/calendar y el adjunto .ics', () => {
    const parts = calendarPartsOf(SOURCE);
    expect(parts).toHaveLength(2);
    expect(parts[1]).toContain('SUMMARY:Junta de accionistas');
  });

  it('toMessage pone la invitación delante del cuerpo, una sola vez', () => {
    const m = toMessage(
      { uid: 7, envelope: { subject: 'Invitación: Junta' }, source: SOURCE },
      'INBOX',
    );
    const lines = m.text.split('\n');
    expect(lines[0]).toMatch(
      /^📅 Invitación: «Junta de accionistas, Q4» — viernes 20 nov, 09:30–10:30 · IFEMA, Madrid/,
    );
    expect(m.text.match(/📅 Invitación/g)).toHaveLength(1);
    expect(m.text).toContain('Te invito a la junta.');
    // Un correo normal no cambia.
    const normal = toMessage({ uid: 8, source: 'Content-Type: text/plain\r\n\r\nHola' }, 'INBOX');
    expect(normal.text).toBe('Hola');
  });
});

describe('gaps-15: un .ics mandado por Telegram → «📅 ¿Lo apunto?» sin modelo', () => {
  const CHAT = '111';
  const deps = (download: () => Promise<Buffer | null>) => ({
    complete: async () => {
      throw new Error('no debe llamar al modelo');
    },
    fetchRaw: async () => '',
    videoText: async () => ({ ok: false as const, reason: 'no' }),
    download,
  });

  it('se lee, sin modelo, y pregunta con «✅ Sí, apúntalo»', async () => {
    const { item } = store.add(
      CHAT,
      { kind: 'texto', fileId: 'F1', mimeType: 'text/calendar', fileName: 'invite.ics' },
      NOV11,
      '2026-11-11',
    );
    const r = await processItem(item, deps(async () => Buffer.from(GOOGLE)) as never);
    expect(r.extra.evento?.nombre).toBe('Junta de accionistas, Q4');
    store.saveResult(item.id, r, NOV11);
    const done = store.get(item.id);
    if (!done) throw new Error('sin cosa');
    expect(cardText(done, NOV11).split('\n')[0]).toBe('📅 Invitación de calendario');
    const aviso = await icsAviso(done, {
      store,
      queue: new BandejaQueue(store, deps(async () => null) as never),
      chatId: CHAT,
      now: () => NOV11,
      timeZone: () => MAD,
    });
    expect(aviso?.text).toMatch(
      /^📅 #\d+ es una invitación\. 📅 ¿Lo apunto en tu Google Calendar\?/,
    );
    expect(aviso?.text).toContain('viernes 20 nov, 09:30–10:30');
    expect(commandFromCallback(aviso?.buttons?.[0]?.action ?? '')).toBe(
      `/bandeja apuntar ${item.id}`,
    );
  });

  it('una cancelación no ofrece apuntar; un .ics sin eventos da un ⚠️ claro', async () => {
    const { item } = store.add(
      CHAT,
      { kind: 'texto', fileId: 'F2', mimeType: 'text/calendar', fileName: 'cancel.ics' },
      NOV11,
      '2026-11-11',
    );
    const cancel = GOOGLE.replace('METHOD:REQUEST', 'METHOD:CANCEL');
    const r = await processItem(item, deps(async () => Buffer.from(cancel)) as never);
    expect(r.extra.evento).toBeUndefined();
    expect(r.verdict).toBe('paja');
    await expect(
      processItem(item, deps(async () => Buffer.from('BEGIN:VCALENDAR\r\nEND:VCALENDAR')) as never),
    ).rejects.toThrow('no trae ningún evento');
  });
});
