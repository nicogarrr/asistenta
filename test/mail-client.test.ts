import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailAccount } from '../src/mail/types.js';
import { GMAIL_IMAP_HOST, GMAIL_IMAP_PORT, GMAIL_SMTP_HOST } from '../src/mail/types.js';

// Pruebas de src/mail/client.ts con IMAP, SMTP y vault falsos: nada sale de la máquina.
const vault = new Map<string, string>();
vi.mock('../src/vault.js', () => ({ vaultGet: vi.fn(async (k: string) => vault.get(k) ?? null) }));
vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type Raw = { uid: number; envelope: { subject?: string; date?: Date }; source: string };
let mailbox: Raw[] = [];
const search = vi.fn(async () => mailbox.map((m) => m.uid));
const fetchOne = vi.fn(async (uid: string) => mailbox.find((m) => String(m.uid) === uid) ?? false);
vi.mock('imapflow', () => ({
  ImapFlow: vi.fn(() => ({
    connect: vi.fn(async () => {}),
    getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
    close: vi.fn(),
    logout: vi.fn(async () => {}),
    search,
    fetchOne,
  })),
}));

const smtpSend = vi.fn(async (_opts: Record<string, unknown>) => ({ messageId: '<id@x>' }));
const createTransport = vi.fn((_opts: Record<string, unknown>) => ({
  sendMail: smtpSend,
  close: vi.fn(),
}));
vi.mock('nodemailer', () => ({
  createTransport: (o: Record<string, unknown>) => createTransport(o),
}));

const { loadAccount, searchMail, sendMail, toMessage } = await import('../src/mail/client.js');

const ACCOUNT: MailAccount = {
  address: 'yo@ejemplo.com',
  password: 'clave',
  imapHost: 'imap.ejemplo.com',
  imapPort: 993,
  smtpHost: 'smtp.ejemplo.com',
  smtpPort: 465,
};

const msg = (uid: number, subject: string, body = 'hola'): Raw => ({
  uid,
  envelope: { subject, date: new Date(2026, 9, uid) },
  source: `Subject: ${subject}\r\nContent-Type: text/plain\r\n\r\n${body}`,
});

beforeEach(() => {
  vault.clear();
  mailbox = [];
  search.mockClear();
  fetchOne.mockClear();
  smtpSend.mockClear();
  createTransport.mockClear();
});

describe('toMessage', () => {
  it('un asunto vacío o en blanco se muestra como «(sin asunto)»', () => {
    expect(toMessage({ uid: 1, envelope: { subject: '' } }, 'INBOX').subject).toBe('(sin asunto)');
    expect(toMessage({ uid: 1, envelope: { subject: '   ' } }, 'INBOX').subject).toBe(
      '(sin asunto)',
    );
    expect(toMessage({ uid: 1, envelope: { subject: 'Hola' } }, 'INBOX').subject).toBe('Hola');
  });

  it('una cabecera Date ilegible da 0, nunca NaN', () => {
    const m = toMessage({ uid: 1, envelope: { date: new Date('no es fecha') } }, 'INBOX');
    expect(m.at).toBe(0);
  });

  it('remitentes, destinatarios y leído', () => {
    const m = toMessage(
      {
        uid: 7,
        envelope: { from: [{ address: 'a@x' }, {}], to: [{ address: 'b@x' }, { address: '' }] },
        flags: new Set(['\\Seen']),
      },
      'INBOX',
    );
    expect(m).toMatchObject({ id: '7', from: 'a@x', to: ['b@x'], seen: true, at: 0 });
  });
});

describe('loadAccount', () => {
  it('sin dirección o contraseña no hay cuenta', async () => {
    vault.set('mail:address', 'yo@x');
    expect(await loadAccount()).toBeNull();
  });

  it('host y puerto vaciados en el vault usan los de por defecto, no localhost ni 0', async () => {
    vault.set('mail:address', 'yo@x');
    vault.set('mail:password', 'p');
    vault.set('mail:imapHost', '');
    vault.set('mail:imapPort', '');
    vault.set('mail:smtpHost', '  ');
    vault.set('mail:smtpPort', 'abc');
    const acc = await loadAccount();
    expect(acc?.imapHost).toBe(GMAIL_IMAP_HOST);
    expect(acc?.imapPort).toBe(GMAIL_IMAP_PORT);
    expect(acc?.smtpHost).toBe(GMAIL_SMTP_HOST);
    expect(Number.isInteger(acc?.smtpPort)).toBe(true);
    expect(acc?.smtpPort).toBeGreaterThan(0);
  });

  it('un puerto válido se respeta', async () => {
    vault.set('mail:address', 'yo@x');
    vault.set('mail:password', 'p');
    vault.set('mail:smtpPort', '587');
    vault.set('mail:imapHost', 'imap.otro.es');
    const acc = await loadAccount();
    expect(acc?.smtpPort).toBe(587);
    expect(acc?.imapHost).toBe('imap.otro.es');
  });
});

describe('searchMail', () => {
  it('los más nuevos primero y respeta el límite; pasa los criterios al servidor', async () => {
    mailbox = [msg(1, 'uno'), msg(2, 'dos'), msg(3, 'tres')];
    const found = await searchMail(ACCOUNT, { unreadOnly: true, from: 'a@x', since: 0 }, 2);
    expect(found.map((m) => m.subject)).toEqual(['tres', 'dos']);
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ all: true, unseen: true, from: 'a@x' }),
      { uid: true },
    );
  });

  it('un uid que ya no existe se salta', async () => {
    mailbox = [msg(1, 'uno')];
    search.mockResolvedValueOnce([1, 2]);
    const found = await searchMail(ACCOUNT, {}, 5);
    expect(found.map((m) => m.subject)).toEqual(['uno']);
  });

  it('el texto libre no distingue tildes ni mayúsculas', async () => {
    mailbox = [msg(1, 'Reunión del lunes'), msg(2, 'Otra cosa')];
    const found = await searchMail(ACCOUNT, { q: 'REUNION' }, 5);
    expect(found.map((m) => m.subject)).toEqual(['Reunión del lunes']);
  });

  it('el texto libre mira más allá de los `limit` correos más nuevos', async () => {
    mailbox = [
      msg(1, 'Billete Renfe'),
      ...Array.from({ length: 10 }, (_, i) => msg(i + 2, `aviso ${i}`)),
    ];
    const found = await searchMail(ACCOUNT, { q: 'renfe' }, 3);
    expect(found.map((m) => m.subject)).toEqual(['Billete Renfe']);
  });

  it('con texto libre deja de leer al reunir `limit` aciertos', async () => {
    mailbox = Array.from({ length: 10 }, (_, i) => msg(i + 1, `factura ${i}`));
    const found = await searchMail(ACCOUNT, { q: 'factura' }, 2);
    expect(found).toHaveLength(2);
    expect(fetchOne).toHaveBeenCalledTimes(2);
  });
});

describe('sendMail', () => {
  it('destinatarios en blanco no cuentan y no se abre el SMTP', async () => {
    const r = await sendMail(ACCOUNT, { to: ['', '  '], subject: 'a', text: 'b' });
    expect(r).toEqual({ ok: false, error: 'falta el destinatario' });
    expect(createTransport).not.toHaveBeenCalled();
  });

  it('quita los huecos de los destinatarios', async () => {
    const r = await sendMail(ACCOUNT, { to: [' a@x ', '', 'b@x'], subject: 'a', text: 'b' });
    expect(r.ok).toBe(true);
    expect(smtpSend.mock.calls[0]?.[0]).toMatchObject({ to: 'a@x, b@x', from: 'yo@ejemplo.com' });
  });

  it('el SMTP tiene plazos acotados (un servidor colgado no para el turno 10 min)', async () => {
    await sendMail(ACCOUNT, { to: ['a@x'], subject: 'a', text: 'b' });
    const opts = createTransport.mock.calls[0]?.[0] ?? {};
    for (const k of ['connectionTimeout', 'greetingTimeout', 'socketTimeout']) {
      expect(opts[k]).toBeGreaterThan(0);
      expect(opts[k]).toBeLessThanOrEqual(60_000);
    }
    expect(opts.secure).toBe(true);
  });

  it('asunto o cuerpo vacío no envía; un fallo del SMTP vuelve como error', async () => {
    expect(await sendMail(ACCOUNT, { to: ['a@x'], subject: ' ', text: 'b' })).toEqual({
      ok: false,
      error: 'falta asunto o cuerpo',
    });
    smtpSend.mockRejectedValueOnce(new Error('550 buzón lleno'));
    const r = await sendMail(ACCOUNT, { to: ['a@x'], subject: 'a', text: 'b', inReplyTo: '<p@x>' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/550/);
  });
});
