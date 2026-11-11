import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type IdleClient, type IdleDeps, MailIdleTransport } from '../src/mail/idle.js';
import {
  bajarCalendarios,
  calendarioCortado,
  calendarPartIds,
  SOURCE_MAX_BYTES,
} from '../src/mail/invitacion-grande.js';
import type { MailAccount, MailMessage } from '../src/mail/types.js';

const ICS = [
  'BEGIN:VCALENDAR',
  'METHOD:REQUEST',
  'BEGIN:VEVENT',
  'DTSTART;TZID=Europe/Madrid:20261120T093000',
  'DTEND;TZID=Europe/Madrid:20261120T103000',
  'SUMMARY:Comité de inversión',
  'LOCATION:Teams',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

// Un correo de Outlook/Teams: el HTML va antes y pasa de 32 KB; el .ics queda fuera del corte.
const HTML = `<html><body>${'<p style="font-family:Calibri">Únete a la reunión de Teams</p>'.repeat(900)}</body></html>`;
const FULL = [
  'From: Ana <ana@fondo.example>',
  'Subject: Comité de inversión',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="MIX"',
  '',
  '--MIX',
  'Content-Type: text/html; charset=UTF-8',
  '',
  HTML,
  '--MIX',
  'Content-Type: text/calendar; charset=UTF-8; method=REQUEST',
  '',
  ICS,
  '--MIX--',
  '',
].join('\r\n');
const CUT = Buffer.from(FULL, 'utf8').subarray(0, SOURCE_MAX_BYTES);
const STRUCT = {
  type: 'multipart/mixed',
  childNodes: [
    { part: '1', type: 'text/html' },
    { part: '2', type: 'text/calendar', parameters: { method: 'REQUEST' } },
  ],
};

describe('gaps-16: invitación detrás de un HTML de más de 32 KB', () => {
  it('se sabe qué parte es el calendario, y solo se baja si la fuente vino cortada', () => {
    expect(FULL.length).toBeGreaterThan(SOURCE_MAX_BYTES);
    expect(calendarPartIds(STRUCT)).toEqual(['2']);
    expect(
      calendarPartIds({
        childNodes: [
          { part: '3', type: 'application/octet-stream', parameters: { name: 'x.ics' } },
        ],
      }),
    ).toEqual(['3']);
    expect(calendarioCortado(CUT, STRUCT)).toEqual(['2']);
    // Entera (no cortada) no hace falta nada.
    expect(calendarioCortado('Content-Type: text/plain\r\n\r\nHola', STRUCT)).toEqual([]);
    // Cortada pero sin calendario en la estructura: nada.
    expect(calendarioCortado(CUT, { childNodes: [{ part: '1', type: 'text/html' }] })).toEqual([]);
  });

  it('bajarCalendarios lee la parte; un fallo no rompe nada', async () => {
    const download = vi.fn(async (_uid: string, part?: string) =>
      part === '2' ? { content: Readable.from([Buffer.from(ICS)]) } : {},
    );
    expect(await bajarCalendarios({ download }, 9, ['2'])).toEqual([ICS]);
    expect(download).toHaveBeenCalledWith('9', '2', expect.objectContaining({ uid: true }));
    const roto = vi.fn(async () => {
      throw new Error('BAD');
    });
    expect(await bajarCalendarios({ download: roto }, 9, ['2'])).toEqual([]);
  });
});

const account: MailAccount = {
  address: 'me@example.test',
  password: 'private',
  imapHost: 'imap.gmail.com',
  imapPort: 993,
  smtpHost: 'smtp.gmail.com',
  smtpPort: 465,
};
class Mock extends EventEmitter {
  capabilities = new Map<string, unknown>([['IDLE', true]]);
  box = { uidValidity: 1n, uidNext: 6, readOnly: true };
  connect = vi.fn(async () => {});
  mailboxOpen = vi.fn(async () => ({ ...this.box }));
  search = vi.fn(async () => [5]);
  fetchOne = vi.fn(async (uid: string) => ({
    uid: Number(uid),
    source: CUT,
    envelope: { subject: 'Comité de inversión' },
    internalDate: new Date(),
    flags: new Set<string>(),
    bodyStructure: STRUCT,
  }));
  download = vi.fn(async (_uid: string, part?: string) =>
    part === '2' ? { content: Readable.from([Buffer.from(ICS)]) } : {},
  );
  private done: (() => void) | null = null;
  idle = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        this.done = () => resolve(true);
      }),
  );
  close = vi.fn(() => {
    this.emit('close');
    this.done?.();
  });
}
const active: MailIdleTransport[] = [];
afterEach(async () => {
  for (const t of active.splice(0)) await t.stop();
});
const tick = async () => {
  for (let i = 0; i < 60; i++) await new Promise((r) => setImmediate(r));
};

describe('gaps-16: el aviso de correo nuevo (IDLE) trae la invitación grande', () => {
  it('pide BODYSTRUCTURE, baja solo la parte del calendario y la pone delante', async () => {
    const c = new Mock();
    const got: MailMessage[] = [];
    const deps: IdleDeps = {
      account: async () => account,
      load: () => ({ validity: '1', next: 5 }),
      save: () => {},
      deliver: async (messages) => {
        got.push(...messages);
      },
      factory: () => c as unknown as IdleClient,
      status: () => {},
    };
    const t = new MailIdleTransport(deps);
    active.push(t);
    t.start();
    await tick();
    expect(c.fetchOne).toHaveBeenCalledWith(
      '5',
      expect.objectContaining({ bodyStructure: true, source: { maxLength: SOURCE_MAX_BYTES } }),
      { uid: true },
    );
    expect(c.download).toHaveBeenCalledTimes(1);
    expect(got[0]?.text.split('\n')[0]).toMatch(
      /^📅 Invitación: «Comité de inversión» — viernes 20 nov, 09:30–10:30 · Teams/,
    );
  });
});
