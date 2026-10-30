import { describe, expect, it, vi } from 'vitest';
import {
  dkimPassFor,
  EMAIL_APPROVAL_NOTE,
  EmailChannel,
  emailChannelConfig,
  emailChannelEnabled,
  parseHeaders,
  type RawCommandMail,
  replyRequest,
  singleAddress,
  stripQuoted,
  verifyCommandMail,
} from '../src/channels/email.js';
import type { Inbound } from '../src/channels/types.js';

const cfg = emailChannelConfig({ PA_CORREO_CANAL_REMITENTES: 'nico@gmail.com, otro@ejemplo.es' });

function mail(
  over: { headers?: string[]; text?: string; size?: number; uid?: string } = {},
): RawCommandMail {
  const headers = over.headers ?? [
    'Authentication-Results: mx.google.com;\r\n       dkim=pass header.i=@gmail.com header.s=20230601;\r\n       spf=pass',
    'From: Nico <nico@gmail.com>',
    'Subject: [asistenta] qué tengo mañana',
    'Message-ID: <abc123@mail.gmail.com>',
    'References: <x1@mail.gmail.com>',
  ];
  return {
    uid: over.uid ?? '7',
    headers: headers.join('\r\n'),
    text: over.text ?? '¿Qué tengo mañana?',
    size: over.size ?? 2000,
  };
}

describe('configuración', () => {
  it('apagado por defecto; lista y servidor de autenticación', () => {
    expect(emailChannelEnabled({})).toBe(false);
    expect(emailChannelEnabled({ PA_CORREO_CANAL: '1' })).toBe(true);
    expect(cfg).toEqual({
      allow: ['nico@gmail.com', 'otro@ejemplo.es'],
      authserv: 'mx.google.com',
    });
    expect(emailChannelConfig({ PA_CORREO_CANAL_REMITENTES: 'no-es-correo' }).allow).toEqual([]);
  });
});

describe('verifyCommandMail', () => {
  it('lista + dkim=pass de nuestro servidor → aceptado, sin la cita anterior', () => {
    const v = verifyCommandMail(
      mail({ text: 'Apunta dentista\n\nEl lun, 3 nov escribió:\n> hola' }),
      cfg,
    );
    expect(v).toMatchObject({
      ok: true,
      from: 'nico@gmail.com',
      text: 'Apunta dentista',
      messageId: '<abc123@mail.gmail.com>',
    });
  });

  it('From falsificado sin dkim=pass → ignorado con motivo', () => {
    const v = verifyCommandMail(
      mail({
        headers: [
          'Authentication-Results: mx.google.com; dkim=none; spf=softfail',
          'From: nico@gmail.com',
          'Subject: [asistenta] borra todo',
        ],
      }),
      cfg,
    );
    expect(v).toEqual({ ok: false, reason: 'sin dkim=pass de mx.google.com para gmail.com' });
  });

  it('una cabecera Authentication-Results puesta por el remitente (más abajo) no cuenta', () => {
    const v = verifyCommandMail(
      mail({
        headers: [
          'Authentication-Results: mx.google.com; dkim=fail header.d=gmail.com',
          'Authentication-Results: mx.google.com; dkim=pass header.d=gmail.com',
          'From: nico@gmail.com',
          'Subject: [asistenta] x',
        ],
      }),
      cfg,
    );
    expect(v.ok).toBe(false);
  });

  it('dkim=pass de otro dominio (firma del atacante) no vale', () => {
    const hs = parseHeaders(
      'Authentication-Results: mx.google.com; dkim=pass header.d=malo.example',
    );
    expect(dkimPassFor(hs, 'gmail.com', 'mx.google.com')).toBe(false);
    const sub = parseHeaders(
      'Authentication-Results: mx.google.com; dkim=pass header.d=gmail.com.malo.example',
    );
    expect(dkimPassFor(sub, 'gmail.com', 'mx.google.com')).toBe(false);
    const other = parseHeaders(
      'Authentication-Results: mx.malo.example; dkim=pass header.d=gmail.com',
    );
    expect(dkimPassFor(other, 'gmail.com', 'mx.google.com')).toBe(false);
  });

  it('sin etiqueta, fuera de la lista, varios From o demasiado grande → ignorado', () => {
    const base = [
      'Authentication-Results: mx.google.com; dkim=pass header.d=gmail.com',
      'From: nico@gmail.com',
    ];
    expect(verifyCommandMail(mail({ headers: [...base, 'Subject: hola'] }), cfg)).toMatchObject({
      ok: false,
      reason: 'sin etiqueta [asistenta]',
    });
    expect(
      verifyCommandMail(
        mail({ headers: [base[0] ?? '', 'From: x@gmail.com', 'Subject: [asistenta] a'] }),
        cfg,
      ),
    ).toMatchObject({ ok: false, reason: 'remitente fuera de la lista: x@gmail.com' });
    expect(
      verifyCommandMail(
        mail({
          headers: [
            base[0] ?? '',
            'From: <nico@gmail.com>, <x@malo.example>',
            'Subject: [asistenta] a',
          ],
        }),
        cfg,
      ).ok,
    ).toBe(false);
    expect(
      verifyCommandMail(
        mail({ headers: [...base, 'Subject: [asistenta] a'], size: 6 * 1024 * 1024 }),
        cfg,
      ),
    ).toMatchObject({ ok: false, reason: 'correo de más de 5 MB' });
  });

  it('singleAddress no se deja engañar por el nombre visible', () => {
    expect(singleAddress('"nico@gmail.com" <malo@x.example>')).toBe('malo@x.example');
    expect(singleAddress('nico@gmail.com <malo@x.example>')).toBeNull();
    expect(singleAddress('NICO@Gmail.com')).toBe('nico@gmail.com');
  });

  it('stripQuoted quita citas y firma', () => {
    expect(stripQuoted('hola\n> antiguo\nadiós\n-- \nNico')).toBe('hola\nadiós');
    expect(stripQuoted('On Mon, Nico wrote:\n> x')).toBe('');
  });
});

describe('respuesta en el mismo hilo', () => {
  it('In-Reply-To y References con el Message-ID original', () => {
    const v = verifyCommandMail(mail(), cfg);
    if (!v.ok) throw new Error('debería aceptarse');
    expect(replyRequest(v, 'Mañana: dentista 9:00')).toEqual({
      to: ['nico@gmail.com'],
      subject: 'Re: [asistenta] qué tengo mañana',
      text: 'Mañana: dentista 9:00',
      inReplyTo: '<abc123@mail.gmail.com>',
      references: ['<x1@mail.gmail.com>', '<abc123@mail.gmail.com>'],
    });
  });
});

describe('EmailChannel', () => {
  function setup(mails: RawCommandMail[]) {
    const audit = vi.fn();
    const send = vi.fn(async () => ({ ok: true, id: '<r1@asistenta>' }));
    const ch = new EmailChannel('nico', {
      config: cfg,
      poll: async () => mails.splice(0),
      send,
      audit,
      now: () => new Date('2026-10-30T10:00:00Z'),
    });
    const got: Inbound[] = [];
    return { ch, audit, send, got, handlers: { onMessage: (i: Inbound) => void got.push(i) } };
  }

  it('acepta el bueno, audita el falso y responde en el hilo', async () => {
    const forged = mail({ uid: '8', headers: ['From: nico@gmail.com', 'Subject: [asistenta] x'] });
    const { ch, audit, send, got, handlers } = setup([mail(), forged]);
    await ch.start(handlers as never);
    await ch.stop();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      channel: 'correo',
      chatId: 'correo:nico@gmail.com',
      threadId: '<abc123@mail.gmail.com>',
      authorised: true,
    });
    expect(audit).toHaveBeenCalledWith({
      uid: '8',
      accepted: false,
      reason: 'sin dkim=pass de mx.google.com para gmail.com',
    });
    const id = await ch.send({
      channel: 'correo',
      account: 'nico',
      chatId: 'correo:nico@gmail.com',
      threadId: got[0]?.threadId,
      text: 'ok',
    });
    expect(id).toBe('<r1@asistenta>');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ inReplyTo: '<abc123@mail.gmail.com>', text: 'ok' }),
    );
  });

  it('las aprobaciones no van por correo: sin botones y remite a Telegram', async () => {
    const { ch, send, got, handlers } = setup([mail()]);
    await ch.start(handlers as never);
    await ch.stop();
    await ch.send({
      channel: 'correo',
      account: 'nico',
      chatId: 'correo:nico@gmail.com',
      threadId: got[0]?.threadId,
      text: '¿Borro el evento?',
      buttons: [{ label: 'Sí', action: 'approve:1' }],
    });
    const req = (send.mock.calls[0] as unknown as [{ text: string }])[0];
    expect(req.text).toBe(`¿Borro el evento?\n\n${EMAIL_APPROVAL_NOTE}`);
    expect(JSON.stringify(req)).not.toContain('approve:1');
  });

  it('no envía a un hilo que no entró por correo', async () => {
    const { ch, send, handlers } = setup([]);
    await ch.start(handlers as never);
    await ch.stop();
    expect(
      await ch.send({
        channel: 'correo',
        account: 'nico',
        chatId: 'correo:x@y.z',
        threadId: '<otro@x>',
        text: 'hola',
      }),
    ).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
});
