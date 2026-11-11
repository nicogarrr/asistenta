import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandButton, commandFromCallback } from '../src/channels/telegram-shared.js';
import { type IdleClient, MailIdleTransport } from '../src/mail/idle.js';
import {
  argsDe,
  InvitacionesCorreo,
  invitacionesDe,
  invitacionOrden,
  textoInvitacion,
} from '../src/mail/invitacion-aviso.js';
import type { MailAccount, MailMessage } from '../src/mail/types.js';

const TZ = 'Europe/Madrid';
const NOW = new Date('2026-11-11T18:00:00Z');
const ics = (metodo: string | null, dtstart: string, extra = '') =>
  [
    'BEGIN:VCALENDAR',
    ...(metodo ? [`METHOD:${metodo}`] : []),
    'BEGIN:VEVENT',
    `DTSTART;TZID=Europe/Madrid:${dtstart}`,
    'DTEND;TZID=Europe/Madrid:20261120T103000',
    'SUMMARY:Comité de inversión',
    'LOCATION:Teams',
    extra,
    'END:VEVENT',
    'END:VCALENDAR',
  ]
    .filter(Boolean)
    .join('\r\n');
const MAIL = { from: 'ana@fondo.example', subject: 'Invitación: Comité de inversión' };

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-gaps16-invitacion-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('gaps-16: invitación por correo → «📅 ¿La apunto?» con botón', () => {
  it('solo invitaciones de verdad (REQUEST), futuras y no canceladas', () => {
    const [i] = invitacionesDe([ics('REQUEST', '20261120T093000')], MAIL, TZ, NOW);
    expect(i).toMatchObject({
      titulo: 'Comité de inversión',
      inicio: '2026-11-20T09:30',
      fin: '2026-11-20T10:30',
      lugar: 'Teams',
      de: 'ana@fondo.example',
    });
    expect(i?.clave).toMatch(/^[0-9a-f]{10}$/);
    // Un boletín (PUBLISH o sin METHOD), una cancelación o algo que ya pasó: nada.
    expect(invitacionesDe([ics('PUBLISH', '20261120T093000')], MAIL, TZ, NOW)).toEqual([]);
    expect(invitacionesDe([ics(null, '20261120T093000')], MAIL, TZ, NOW)).toEqual([]);
    expect(invitacionesDe([ics('CANCEL', '20261120T093000')], MAIL, TZ, NOW)).toEqual([]);
    expect(
      invitacionesDe([ics('REQUEST', '20261120T093000', 'STATUS:CANCELLED')], MAIL, TZ, NOW),
    ).toEqual([]);
    expect(
      invitacionesDe(
        [ics('REQUEST', '20261101T093000').replace('20261120T103000', '20261101T103000')],
        MAIL,
        TZ,
        NOW,
      ),
    ).toEqual([]);
  });

  it('una tarjeta por evento (un reenvío no repite) y «/invitacion off» las calla', () => {
    const s = new InvitacionesCorreo(join(dir, 'invitaciones-correo.json'));
    const cands = invitacionesDe([ics('REQUEST', '20261120T093000')], MAIL, TZ, NOW);
    expect(s.nuevas(cands, TZ, NOW)).toHaveLength(1);
    expect(s.nuevas(cands, TZ, NOW)).toEqual([]);
    const clave = cands[0]?.clave ?? '';
    expect(s.get(clave)?.titulo).toBe('Comité de inversión');
    s.marcarApuntada(clave);
    expect(s.get(clave)?.apuntada).toBe(true);
    s.setApagadas(true);
    const otra = invitacionesDe(
      [ics('REQUEST', '20261120T093000').replace('Comité', 'Junta')],
      MAIL,
      TZ,
      NOW,
    );
    expect(s.nuevas(otra, TZ, NOW)).toEqual([]);
    s.setApagadas(false);
    expect(s.nuevas(otra, TZ, NOW)).toHaveLength(1);
  });

  it('texto, botones y órdenes', () => {
    const [i] = invitacionesDe([ics('REQUEST', '20261120T093000')], MAIL, TZ, NOW);
    if (!i) throw new Error('sin invitación');
    const t = textoInvitacion(i);
    expect(t).toContain('📅 Te ha llegado una invitación por correo de ana@fondo.example');
    expect(t).toContain('«Comité de inversión» — viernes 20 nov, 09:30–10:30 · Teams');
    expect(t).toContain('/invitacion off');
    const si = commandButton('✅ Sí, apúntala', 'invitacion', i.clave, 'apuntar');
    expect(commandFromCallback(si?.action ?? '')).toBe(`/invitacion apuntar ${i.clave}`);
    const icsB = commandButton('📲 .ics (iPhone)', 'invitacion', i.clave, 'ics');
    expect(commandFromCallback(icsB?.action ?? '')).toBe(`/invitacion ics ${i.clave}`);
    expect(invitacionOrden(`apuntar ${i.clave}`)).toEqual({ kind: 'apuntar', clave: i.clave });
    expect(invitacionOrden('off')).toEqual({ kind: 'off' });
    expect(invitacionOrden('apuntar ../x')).toBeNull();
    expect(argsDe(i)).toMatchObject({
      titulo: 'Comité de inversión',
      inicio: '2026-11-20T09:30',
      fin: '2026-11-20T10:30',
      lugar: 'Teams',
    });
  });

  it('cli: el aviso de correo nuevo manda la tarjeta; «apuntar» una sola vez', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf8');
    const d = src.indexOf('deliver: async (messages, scope) => {');
    expect(src.slice(d, d + 400)).toContain('await avisarInvitacionesCorreo(messages)');
    expect(src).toContain("commandButton('✅ Sí, apúntala', 'invitacion', inv.clave, 'apuntar')");
    expect(src).toContain('if (invitacionEnCurso.has(inv.clave)) return;');
    expect(src).toContain('if (ok) store.marcarApuntada(inv.clave);');
    expect(src).toContain("names: ['invitacion', 'invitaciones']");
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
const SOURCE = [
  'Subject: Comité',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="MIX"',
  '',
  '--MIX',
  'Content-Type: text/plain; charset=UTF-8',
  '',
  'Te invito.',
  '--MIX',
  'Content-Type: text/calendar; charset=UTF-8; method=REQUEST',
  '',
  ics('REQUEST', '20261120T093000'),
  '--MIX--',
  '',
].join('\r\n');
class Mock extends EventEmitter {
  capabilities = new Map<string, unknown>([['IDLE', true]]);
  box = { uidValidity: 1n, uidNext: 6, readOnly: true };
  connect = vi.fn(async () => {});
  mailboxOpen = vi.fn(async () => ({ ...this.box }));
  search = vi.fn(async () => [5]);
  fetchOne = vi.fn(async (uid: string) => ({
    uid: Number(uid),
    source: Buffer.from(SOURCE),
    envelope: { subject: 'Comité' },
    internalDate: new Date(),
    flags: new Set<string>(),
  }));
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

describe('gaps-16: el correo nuevo (IDLE) trae el .ics en crudo para la tarjeta', () => {
  it('message.calendarios', async () => {
    const c = new Mock();
    const got: MailMessage[] = [];
    const t = new MailIdleTransport({
      account: async () => account,
      load: () => ({ validity: '1', next: 5 }),
      save: () => {},
      deliver: async (m) => {
        got.push(...m);
      },
      factory: () => c as unknown as IdleClient,
      status: () => {},
    });
    t.start();
    for (let i = 0; i < 60; i++) await new Promise((r) => setImmediate(r));
    await t.stop();
    expect(got[0]?.calendarios?.[0]).toContain('METHOD:REQUEST');
    expect(invitacionesDe(got[0]?.calendarios ?? [], MAIL, TZ, NOW)).toHaveLength(1);
  });
});
