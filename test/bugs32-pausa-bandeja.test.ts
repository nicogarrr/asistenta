import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BandejaQueue } from '../src/bandeja/procesar.js';
import { BandejaStore } from '../src/bandeja/store.js';
import type { Inbound, Outbound } from '../src/channels/types.js';
import { guardarEnPausa, servePausa } from '../src/pausa-cli.js';
import { writePausa } from '../src/pausa-pc.js';

// bugs-32 (11 nov 2026): con el PC en pausa («⏸️ Parar todo en el PC»), un enlace que Nico
// mandaba a secas recibía «Estoy en pausa…» y se perdía: la bandeja no estaba.

let d: string;
beforeEach(() => {
  d = mkdtempSync(join(tmpdir(), 'bugs32-pausa-'));
});
afterEach(() => rmSync(d, { recursive: true, force: true }));

const msg = (userId: string, text: string, extra: Partial<Inbound> = {}): Inbound =>
  ({
    channel: 'telegram',
    account: 'main',
    chatId: userId,
    userId,
    text,
    authorised: true,
    isGroup: false,
    messageId: '9',
    receivedAt: new Date().toISOString(),
    ...extra,
  }) as Inbound;

describe('pausa: lo que mandas a secas va a la bandeja', () => {
  it('un enlace a secas se guarda sin procesar; una frase sigue siendo «estoy en pausa»', async () => {
    expect(await guardarEnPausa(d, msg('42', 'https://youtu.be/EWvNQjAaOHw'))).toMatch(
      /^📥 Guardado en la bandeja \(1 hoy\)\. Estoy en pausa/,
    );
    expect(await guardarEnPausa(d, msg('42', 'https://youtu.be/EWvNQjAaOHw'))).toMatch(
      /ya estaba en la bandeja/,
    );
    expect(await guardarEnPausa(d, msg('42', '¿qué tal?'))).toBeNull();
    const store = new BandejaStore(join(d, 'bandeja.db'));
    const items = store.unprocessed();
    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe('nuevo');
    // Al levantar, el daemon normal lo retoma (resume) y lo procesa.
    const queue = new BandejaQueue(store, {
      complete: async () => async () =>
        'TITULO: T\nVEREDICTO: IDEAS\nNOTA: 6\nMOTIVO: m\nIDEAS:\n- a\n- b\n- c\nETIQUETAS: ninguna',
      fetchRaw: async () => '',
      videoText: async () => ({ ok: false, reason: 'no' }),
    });
    expect(queue.resume()).toBe(1);
    await queue.idle();
    // Ya no está «nuevo»: lo cogió la cola (aquí sin red queda juzgado o en ⚠️).
    expect(store.get(items[0]?.id ?? 0)?.status).not.toBe('nuevo');
    store.close();
  });

  it('con la captura apagada (/bandeja captura off) no guarda', async () => {
    const store = new BandejaStore(join(d, 'bandeja.db'));
    store.setMeta('captura', 'off');
    store.close();
    expect(await guardarEnPausa(d, msg('42', 'https://example.com/a'))).toBeNull();
  });

  it('servePausa: el dueño manda un enlace → «📥 Guardado…» con el botón de levantar', async () => {
    writePausa(d, { since: new Date().toISOString(), activo: [], avisado: true });
    const sent: Outbound[] = [];
    let onMessage: ((m: Inbound) => Promise<void> | void) | undefined;
    let stop: ((why: string) => void) | undefined;
    const ready = vi.fn();
    const done = servePausa({
      stateDir: d,
      token: 't',
      allowed: [42],
      ownerId: 42,
      channel: {
        account: 'main',
        start: async (h: { onMessage: (m: Inbound) => Promise<void> | void }) => {
          onMessage = h.onMessage;
        },
        stop: async () => {},
        send: async (o: Outbound) => {
          sent.push(o);
          return '1';
        },
      } as never,
      launch: () => {},
      control: {
        beginResources: () => {},
        attach: (l) => {
          stop = (why) => l.stop(why);
        },
        ready,
      },
    });
    await vi.waitFor(() => expect(ready).toHaveBeenCalled());
    await onMessage?.(msg('42', 'https://example.com/articulo'));
    expect(sent.at(-1)?.text).toMatch(/^📥 Guardado en la bandeja/);
    expect(sent.at(-1)?.buttons?.length).toBe(1);
    await onMessage?.(msg('42', 'hola'));
    expect(sent.at(-1)?.text).toContain('Estoy en pausa');
    stop?.('test');
    expect(await done).toBe(0);
  });
});
