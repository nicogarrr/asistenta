import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { MailMessage } from '../src/mail/types.js';
import { createDeliveriesTool } from '../src/tools/deliveries.js';
import { runVigilanteOnce } from '../src/vigilante.js';

const H = 3_600_000;
const BASE = Date.UTC(2026, 9, 30, 8);
const mail = (
  id: string,
  from: string,
  subject: string,
  text: string,
  at: number,
): MailMessage => ({
  id,
  from,
  to: ['yo@x.es'],
  subject,
  text,
  at,
  seen: true,
  folder: 'INBOX',
});
const REPARTO = mail(
  'r1',
  'noreply@mrw.es',
  'Tu envío está en reparto',
  'Número de envío: 0261234567. Llega hoy.',
  BASE,
);

describe('repartos: herramienta y aviso del vigilante', () => {
  it('«¿dónde está mi pedido?» lee el correo y responde corto', async () => {
    const db = new DatabaseSync(':memory:');
    const say = async (recentMail: () => Promise<MailMessage[] | null>) => {
      const tool = createDeliveriesTool({
        db,
        recentMail,
        timeZone: 'Europe/Madrid',
        now: () => BASE + H,
      });
      return ((await tool.execute('x', {} as never)).content[0] as { text: string }).text;
    };
    expect(await say(async () => null)).toBe(
      'No tengo tu correo configurado, así que no puedo ver los envíos.',
    );
    expect(await say(async () => [REPARTO])).toBe(
      'MRW (0261234567): en reparto (30 oct, 09:00) — Tu envío está en reparto',
    );
    expect(await say(async () => Promise.reject(new Error('imap caído')))).toContain(
      'Ahora no he podido mirar el correo; te digo lo último que vi.',
    );
  });

  it('el vigilante manda UN aviso cuando el paquete sale a reparto', async () => {
    const db = new DatabaseSync(':memory:');
    const sent: string[] = [];
    const run = () =>
      runVigilanteOnce(
        {
          db,
          agenda: async () => ({
            today: [],
            upcoming: [],
            pending: [],
            generatedAt: BASE,
            days: 7,
            counts: { calendar: 0, mail: 0, pending: 0 },
            notes: [],
          }),
          send: async (t) => {
            sent.push(t);
            return true;
          },
          now: () => BASE + H,
          charges: async () => [REPARTO],
        },
        'Europe/Madrid',
      );
    await run();
    await run();
    expect(sent.filter((t) => t.includes('está en reparto'))).toHaveLength(1);
    expect(sent.join('\n')).toContain(
      '📦 Tu paquete de MRW (0261234567) está en reparto: llega hoy.',
    );
  });
});
