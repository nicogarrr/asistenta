import { describe, expect, it } from 'vitest';
import { EmailChannel, emailChannelConfig, type RawCommandMail } from '../src/channels/email.js';

const cfg = emailChannelConfig({ PA_CORREO_CANAL_REMITENTES: 'nico@gmail.com' });

function mail(n: number): RawCommandMail {
  return {
    uid: String(n),
    headers: [
      'Authentication-Results: mx.google.com;\r\n       dkim=pass header.i=@gmail.com header.s=20230601;\r\n       spf=pass smtp.mailfrom=nico@gmail.com',
      'From: Nico <nico@gmail.com>',
      `Subject: [asistenta] correo ${n}`,
      `Message-ID: <m${n}@mail.gmail.com>`,
    ].join('\r\n'),
    text: `Correo número ${n}`,
    size: 2000,
  };
}

describe('canal de correo en un daemon que dura semanas', () => {
  it('no guarda para siempre cada correo recibido: los más antiguos se olvidan', async () => {
    let batch: RawCommandMail[] = [];
    const sent: string[] = [];
    const channel = new EmailChannel('nico@gmail.com', {
      config: cfg,
      poll: async () => {
        const out = batch;
        batch = [];
        return out;
      },
      send: async (req) => {
        sent.push(String((req as { inReplyTo?: string }).inReplyTo ?? ''));
        return { ok: true, id: 'r' };
      },
      audit: () => {},
      intervalMs: 3_600_000,
    });
    let seen = 0;
    await channel.start({
      onMessage: async () => {
        seen++;
      },
    } as never);
    for (let n = 1; n <= 3000; n++) batch.push(mail(n));
    await channel.pollOnce();
    await channel.stop();
    expect(seen).toBe(3000);

    // El último correo sigue teniendo respuesta enganchada…
    expect(
      await channel.send({ text: 'ok', replyToMessageId: '<m3000@mail.gmail.com>' } as never),
    ).toBe('r');
    // …pero el primero de 3.000 ya no ocupa memoria.
    expect(
      await channel.send({ text: 'ok', replyToMessageId: '<m1@mail.gmail.com>' } as never),
    ).toBeNull();
  });
});
