import { describe, expect, it } from 'vitest';
import { pricewatchNotifier } from '../src/watch/pricewatch-notify.js';

function harness(token: string, mainBotToken: string) {
  const bodies: Array<{ url: string; body: Record<string, unknown> }> = [];
  const statuses: number[] = [];
  const send = (async (url: string, init: { body: string }) => {
    bodies.push({ url, body: JSON.parse(init.body) });
    const status = statuses.shift() ?? 200;
    return { ok: status === 200, status };
  }) as unknown as typeof fetch;
  const log = { info: () => {}, warn: () => {} };
  const notify = pricewatchNotifier({
    token,
    mainBotToken,
    chatId: '1',
    out: async () => {},
    log,
    send,
  });
  return { bodies, statuses, notify };
}

const buttons = [{ label: '🔕 Silenciar 1 día', action: 'cmd:precio silenciar a1b2c3d4' }];

describe('pricewatch con bot propio: silenciar escrito', () => {
  it('si avisa otro bot, el aviso dice qué escribir al bot principal', async () => {
    const h = harness('OTRO', 'MAIN');
    await h.notify('Posible error de precio', { buttons });
    expect(h.bodies[0]?.body.reply_markup).toBeUndefined();
    expect(h.bodies[0]?.body.text).toBe(
      'Posible error de precio\n\n🔕 Silenciar 1 día: escribe /precio silenciar a1b2c3d4 al bot principal de Asistenta.',
    );
  });

  it('el bot principal lleva el botón y no la línea escrita', async () => {
    const h = harness('', 'MAIN');
    await h.notify('Posible error de precio', { buttons });
    expect(h.bodies[0]?.body.text).toBe('Posible error de precio');
    expect(h.bodies[0]?.body.reply_markup).toBeDefined();
  });

  it('si el otro bot falla (401) y avisa el principal, va con botón y sin la línea', async () => {
    const h = harness('OTRO', 'MAIN');
    h.statuses.push(401, 200);
    await h.notify('Posible error de precio', { buttons });
    expect(String(h.bodies[0]?.body.text)).toContain('/precio silenciar a1b2c3d4');
    expect(h.bodies[1]?.body.text).toBe('Posible error de precio');
    expect(h.bodies[1]?.body.reply_markup).toBeDefined();
  });

  it('sin botones o sin bot principal, el texto no cambia', async () => {
    const a = harness('OTRO', 'MAIN');
    await a.notify('aviso');
    expect(a.bodies[0]?.body.text).toBe('aviso');
    const b = harness('OTRO', '');
    await b.notify('aviso', { buttons });
    expect(b.bodies[0]?.body.text).toBe('aviso');
  });
});
