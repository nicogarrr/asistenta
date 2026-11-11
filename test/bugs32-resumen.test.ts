import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetDigestForTests,
  DIGEST_MAX_TRIES,
  type DigestDeps,
  digestItems,
  MAX_DIGEST_ITEMS,
  runDigestIfDue,
  sendDigest,
} from '../src/bandeja/resumen.js';
import { BandejaStore } from '../src/bandeja/store.js';

// bugs-32 (11 nov 2026): dos fallos del resumen de la noche.
// 1) Si Telegram fallaba al mandarlo, se repetía CADA MINUTO hasta medianoche. Un resumen
//    largo sale en 2–3 mensajes: si el último fallaba, los primeros llegaban otra vez cada vez.
// 2) Lo que no cabía (más de 15 cosas) quedaba «resumido» sin haber salido, y un 🟡 de un
//    día con mucho no volvía a salir ninguna noche.

const CHAT = '111';
const NOV11 = new Date('2026-11-11T09:00:00Z');
let dir: string;
let store: BandejaStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bugs32-resumen-'));
  store = new BandejaStore(join(dir, 'bandeja.db'));
  _resetDigestForTests();
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function addDone(n: number, verdict: 'imprescindible' | 'ideas' | 'paja', day = '2026-11-11') {
  const { item } = store.add(CHAT, { kind: 'enlace', url: `https://a.com/${n}` }, NOV11, day);
  store.saveResult(
    item.id,
    {
      title: `Cosa ${n}`,
      verdict,
      score: 6,
      reason: 'porque sí',
      ideas: ['idea'],
      costMin: 5,
      costLabel: '📰 5 min',
      extra: { source: 'web' },
    },
    NOV11,
  );
  return item.id;
}

describe('resumen: si Telegram falla, no se repite cada minuto', () => {
  it('reintenta cada 10 min y como mucho 3 veces; luego lo deja para mañana', async () => {
    addDone(1, 'ideas');
    let now = new Date('2026-11-11T20:30:00Z'); // 21:30 en Madrid
    let tries = 0;
    const deps: DigestDeps = {
      store,
      now: () => now,
      owner: () => CHAT,
      send: async () => {
        tries++;
        throw new Error('Bad Request: message is too long');
      },
      env: {},
    };
    const tick = async (min: number) => {
      now = new Date(now.getTime() + min * 60_000);
      return runDigestIfDue(deps);
    };
    expect(await tick(0)).toBe('send-failed');
    for (let i = 0; i < 9; i++) await tick(1); // 21:31 … 21:39: nada
    expect(tries).toBe(1);
    expect(await tick(1)).toBe('send-failed'); // 21:40
    expect(tries).toBe(2);
    for (let i = 0; i < 60; i++) await tick(1);
    expect(tries).toBe(DIGEST_MAX_TRIES);
    // Lo que no salió sigue sin resumir: entra en el de mañana.
    expect(digestItems(store, CHAT, '2026-11-12')).toHaveLength(1);
  });

  it('si al reintentar sale bien, se acabó (y otro día empieza de cero)', async () => {
    addDone(1, 'ideas');
    let now = new Date('2026-11-11T20:30:00Z');
    let fail = true;
    const sent: string[] = [];
    const deps: DigestDeps = {
      store,
      now: () => now,
      owner: () => CHAT,
      send: async (_c, text) => {
        if (fail) return false;
        sent.push(text);
        return true;
      },
      env: {},
    };
    expect(await runDigestIfDue(deps)).toBe('send-failed');
    fail = false;
    now = new Date('2026-11-11T20:41:00Z');
    expect(await runDigestIfDue(deps)).toBe('sent');
    now = new Date('2026-11-11T20:50:00Z');
    expect(await runDigestIfDue(deps)).toBe('not-due');
    expect(sent).toHaveLength(1);
    expect(store.getMeta('digest_fail')).toBeNull();
  });
});

describe('resumen: solo cuenta como resumido lo que salió', () => {
  it('un 🟡 que no cupo en el texto vuelve la noche siguiente', async () => {
    const ids = Array.from({ length: MAX_DIGEST_ITEMS + 3 }, (_, i) => addDone(i + 1, 'ideas'));
    const texts: string[] = [];
    const deps: DigestDeps = {
      store,
      now: () => NOV11,
      owner: () => CHAT,
      send: async (_c, text) => {
        texts.push(text);
        return true;
      },
      env: {},
    };
    expect(await sendDigest(deps, CHAT, '2026-11-11', NOV11)).toBe('sent');
    expect(texts[0]).toContain('…y 3 más');
    const left = ids.slice(MAX_DIGEST_ITEMS);
    for (const id of left) expect(texts[0]).not.toContain(`#${id} `);
    // La noche siguiente: salen los 3 que no cupieron, no los 15 que ya salieron.
    expect(digestItems(store, CHAT, '2026-11-12').map((i) => i.id)).toEqual(left);
  });

  it('la paja que no se listó (más de 8) tampoco se da por resumida', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => addDone(i + 1, 'paja'));
    const deps: DigestDeps = {
      store,
      now: () => NOV11,
      owner: () => CHAT,
      send: async () => true,
      env: {},
    };
    await sendDigest(deps, CHAT, '2026-11-11', NOV11);
    expect(digestItems(store, CHAT, '2026-11-12').map((i) => i.id)).toEqual(ids.slice(8));
  });
});
