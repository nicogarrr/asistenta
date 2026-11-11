import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BandejaStore } from '../src/bandeja/store.js';
import type { Inbound } from '../src/channels/types.js';
import { guardarEnPausa } from '../src/pausa-cli.js';

// bugs-35 (lead de bugs-34 sobre #2287): con el PC en pausa, volver a mandar un enlace que
// había fallado (⚠️) contestaba «📥 Eso ya estaba en la bandeja» y, al levantar, no se
// reintentaba nunca (la cola solo retoma lo «nuevo»). Fuera de la pausa ya se reintentaba
// (#2306): ahora la pausa hace lo mismo.

let d: string;
beforeEach(() => {
  d = mkdtempSync(join(tmpdir(), 'bugs35-pausa-'));
});
afterEach(() => rmSync(d, { recursive: true, force: true }));

const msg = (text: string): Inbound =>
  ({
    channel: 'telegram',
    account: 'main',
    chatId: '42',
    userId: '42',
    text,
    authorised: true,
    isGroup: false,
    messageId: '9',
    receivedAt: new Date().toISOString(),
  }) as Inbound;

const URL = 'https://example.com/articulo-largo';

describe('pausa: lo que falló (⚠️) y vuelves a mandar se reintenta al levantar', () => {
  it('un enlace en ⚠️ vuelve a «nuevo» y el aviso no dice «ya estaba»', async () => {
    expect(await guardarEnPausa(d, msg(URL))).toMatch(/^📥 Guardado/);
    let store = new BandejaStore(join(d, 'bandeja.db'));
    const id = store.unprocessed()[0]?.id ?? 0;
    store.setStatus(id, 'error', 'la web no contestó');
    expect(store.unprocessed()).toHaveLength(0);
    store.close();

    const ack = await guardarEnPausa(d, msg(URL));
    expect(ack).not.toMatch(/ya estaba/);
    expect(ack).toMatch(/intent/i);
    expect(ack).toMatch(/pausa/);

    store = new BandejaStore(join(d, 'bandeja.db'));
    const again = store.unprocessed();
    expect(again.map((i) => i.id)).toEqual([id]);
    expect(again[0]?.status).toBe('nuevo');
    expect(again[0]?.error ?? null).toBeNull();
    store.close();
  });

  it('lo que ya estaba bien sigue siendo «ya estaba»', async () => {
    await guardarEnPausa(d, msg(URL));
    expect(await guardarEnPausa(d, msg(URL))).toMatch(/ya estaba en la bandeja/);
  });
});
