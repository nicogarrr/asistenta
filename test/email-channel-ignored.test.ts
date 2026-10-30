import { describe, expect, it, vi } from 'vitest';
import {
  EMAIL_TOO_BIG_TEXT,
  EmailChannel,
  emailAuditRecord,
  emailChannelConfig,
  type RawCommandMail,
  verifyCommandMail,
} from '../src/channels/email.js';

const cfg = emailChannelConfig({ PA_CORREO_CANAL_REMITENTES: 'nico@gmail.com' });
const DKIM = 'Authentication-Results: mx.google.com; dkim=pass header.i=@gmail.com';

function mail(
  over: { from?: string; dkim?: boolean; size?: number; uid?: string } = {},
): RawCommandMail {
  return {
    uid: over.uid ?? '9',
    headers: [
      ...(over.dkim === false
        ? []
        : [DKIM.replace('gmail.com', (over.from ?? 'nico@gmail.com').split('@')[1] ?? '')]),
      `From: ${over.from ?? 'nico@gmail.com'}`,
      'Subject: [asistenta] mira el pdf',
      'Message-ID: <big1@mail.gmail.com>',
    ].join('\r\n'),
    text: 'te mando el contrato',
    size: over.size ?? 2000,
  };
}

function setup(mails: RawCommandMail[], sendOk = true) {
  const audit = vi.fn();
  const send = vi.fn(async () => (sendOk ? { ok: true, id: '<r@a>' } : { ok: false }));
  const ch = new EmailChannel('nico', {
    config: cfg,
    poll: async () => mails.splice(0),
    send: send as never,
    audit,
  });
  const got: unknown[] = [];
  return { ch, audit, send, got, handlers: { onMessage: (i: unknown) => void got.push(i) } };
}

describe('correo de más de 5 MB', () => {
  it('remitente verificado: no se lee, se le avisa en el mismo hilo y se audita', async () => {
    const { ch, audit, send, got, handlers } = setup([mail({ size: 6 * 1024 * 1024 })]);
    await ch.start(handlers as never);
    await ch.stop();
    expect(got).toHaveLength(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ['nico@gmail.com'],
        subject: 'Re: [asistenta] mira el pdf',
        text: EMAIL_TOO_BIG_TEXT,
        inReplyTo: '<big1@mail.gmail.com>',
      }),
    );
    expect(audit).toHaveBeenCalledWith({
      uid: '9',
      accepted: false,
      reason: 'correo de más de 5 MB',
      notified: true,
    });
  });

  it('remitente sin dkim o fuera de la lista: nunca se le contesta', async () => {
    const big = 6 * 1024 * 1024;
    const { ch, send, handlers } = setup([
      mail({ size: big, dkim: false, uid: '1' }),
      mail({ size: big, from: 'otro@gmail.com', uid: '2' }),
    ]);
    await ch.start(handlers as never);
    await ch.stop();
    expect(send).not.toHaveBeenCalled();
    expect(verifyCommandMail(mail({ size: big, dkim: false }), cfg)).not.toHaveProperty('notify');
  });

  it('si el aviso falla, se audita que no salió y no se reintenta', async () => {
    const { ch, audit, send, handlers } = setup([mail({ size: 6 * 1024 * 1024 })], false);
    await ch.start(handlers as never);
    await ch.stop();
    expect(send).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ notified: false }));
  });
});

describe('emailAuditRecord: lo ignorado va a pa auditoria', () => {
  it('registro bloqueado con uid y motivo', () => {
    expect(
      emailAuditRecord({
        uid: '8',
        accepted: false,
        reason: 'remitente fuera de la lista: x@y.es',
      }),
    ).toEqual({
      actor: 'correo',
      action: 'correo.ignorado',
      target: 'uid:8',
      result: 'blocked',
      detail: 'remitente fuera de la lista: x@y.es',
    });
  });
  it('dice si el aviso de tamaño salió', () => {
    expect(
      emailAuditRecord({
        uid: '9',
        accepted: false,
        reason: 'correo de más de 5 MB',
        notified: false,
      }).detail,
    ).toBe('correo de más de 5 MB; aviso al remitente NO enviado');
  });
});
