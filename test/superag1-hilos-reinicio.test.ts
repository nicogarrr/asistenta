import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoundedMap } from '../src/bounded-map.js';
import type { Inbound } from '../src/channels/types.js';
import { resolveInboundThread } from '../src/daemon/inbound.js';
import {
  durableMessageThread,
  openReplyThreadStore,
  ReplyThreadStore,
} from '../src/daemon/reply-threads.js';
import { splitGoalScope } from '../src/goals/store.js';
import { loadDatabaseSync } from '../src/sqlite.js';

// Responder a un mensaje antiguo sigue en su conversación también tras reiniciar
// (o autoactualizarse): el mapa mensaje → hilo tiene copia en disco.

const CK = 'telegram:bot:42';
let dir: string;
let file: string;
const open = () => {
  const DatabaseSync = loadDatabaseSync();
  return new DatabaseSync(file);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sa1-hilos-'));
  file = join(dir, 'memory.db');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type T = { key: string; active: boolean; label?: string };
const inb = (over: Partial<Inbound> = {}): Inbound =>
  ({
    channel: 'telegram',
    account: 'bot',
    chatId: '42',
    userId: '1',
    text: 'y mándalo también por correo',
    messageId: '500',
    ...over,
  }) as Inbound;

/** Un daemon recién arrancado: ningún hilo vivo, el principal ocupado. */
function freshDaemon(durable?: (key: string) => { threadKey: string; label?: string } | undefined) {
  const main: T = { key: `${CK}#main`, active: true };
  const getOrCreateThread = vi.fn(
    async (chatKey: string, name: string, label: string): Promise<T> => ({
      key: `${chatKey}#${name}`,
      active: false,
      label,
    }),
  );
  return {
    activeTopic: new Map<string, string>(),
    messageThread: new Map<string, string>(),
    durableThread: durable,
    threads: new Map<string, T>(),
    goalScopeBySentId: vi.fn((): string | null => null),
    splitGoalScope,
    getOrCreateThread,
    defaultThread: vi.fn(async () => main),
    looksLikeFollowUp: vi.fn(() => false),
    main,
  };
}

describe('ReplyThreadStore', () => {
  it('lo apuntado antes de reiniciar se lee después (otra conexión, mismo fichero)', () => {
    const db1 = open();
    const before = new ReplyThreadStore(db1);
    before.set(`${CK}:77`, `${CK}#m70`, 'vuelo a Bilbao');
    db1.close();

    const db2 = open();
    const after = new ReplyThreadStore(db2);
    expect(after.get(`${CK}:77`)).toEqual({ threadKey: `${CK}#m70`, label: 'vuelo a Bilbao' });
    expect(after.get(`${CK}:78`)).toBeUndefined();
    db2.close();
  });

  it('poda por antigüedad', () => {
    let now = 1_000_000;
    const db = open();
    const store = new ReplyThreadStore(db, { maxAgeMs: 1000, now: () => now });
    store.set(`${CK}:1`, `${CK}#main`);
    now += 2000;
    expect(store.get(`${CK}:1`)).toBeUndefined();
    store.prune();
    expect(store.count()).toBe(0);
    db.close();
  });

  it('poda por número de filas: se quedan las más recientes', () => {
    let now = 1;
    const db = open();
    const store = new ReplyThreadStore(db, { maxRows: 3, now: () => now++ });
    for (let i = 0; i < 6; i++) store.set(`${CK}:${i}`, `${CK}#m${i}`);
    store.prune();
    expect(store.count()).toBe(3);
    expect(store.get(`${CK}:0`)).toBeUndefined();
    expect(store.get(`${CK}:5`)?.threadKey).toBe(`${CK}#m5`);
    db.close();
  });

  it('si la base no abre, el daemon sigue (sin copia en disco)', () => {
    const onError = vi.fn();
    const broken = {
      exec: () => {
        throw new Error('disk I/O error');
      },
    } as unknown as Parameters<typeof openReplyThreadStore>[0];
    expect(openReplyThreadStore(broken, onError)).toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe('durableMessageThread', () => {
  it('escribe en memoria y en disco; get solo mira la memoria; durable mira los dos', () => {
    const db = open();
    const store = new ReplyThreadStore(db);
    const live = durableMessageThread(new BoundedMap<string, string>(10), store, {
      labelOf: () => 'facturas',
    });
    live.set(`${CK}:9`, `${CK}#m9`);
    expect(live.get(`${CK}:9`)).toBe(`${CK}#m9`);

    // «Reinicio»: memoria nueva, mismo disco.
    const restarted = durableMessageThread(new BoundedMap<string, string>(10), store);
    expect(restarted.get(`${CK}:9`)).toBeUndefined(); // la cita de la respuesta sigue entrando
    expect(restarted.durable(`${CK}:9`)).toEqual({ threadKey: `${CK}#m9`, label: 'facturas' });
    db.close();
  });

  it('al retirar un hilo, su memoria se olvida y el disco lo conserva', () => {
    const db = open();
    const m = durableMessageThread(new BoundedMap<string, string>(10), new ReplyThreadStore(db));
    m.set(`${CK}:1`, `${CK}#m1`);
    m.set(`${CK}:2`, `${CK}#main`);
    m.forgetThread(`${CK}#m1`);
    expect(m.get(`${CK}:1`)).toBeUndefined();
    expect(m.get(`${CK}:2`)).toBe(`${CK}#main`);
    expect(m.durable(`${CK}:1`)?.threadKey).toBe(`${CK}#m1`);
    db.close();
  });

  it('un fallo al escribir en disco no rompe el envío', () => {
    const onError = vi.fn();
    const m = durableMessageThread(
      new BoundedMap<string, string>(10),
      {
        set: () => {
          throw new Error('SQLITE_FULL');
        },
        get: () => undefined,
      },
      { onError },
    );
    expect(() => m.set(`${CK}:1`, `${CK}#main`)).not.toThrow();
    expect(m.get(`${CK}:1`)).toBe(`${CK}#main`);
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe('resolveInboundThread tras un reinicio', () => {
  it('responder a un mensaje de un hilo de antes del reinicio → ese hilo, con su etiqueta', async () => {
    const db = open();
    new ReplyThreadStore(db).set(`${CK}:77`, `${CK}#m70`, 'vuelo a Bilbao');
    const store = new ReplyThreadStore(db);
    const d = freshDaemon((k) => store.get(k));
    const t = await resolveInboundThread(inb({ replyToMessageId: '77' }), CK, d);
    expect(t.key).toBe(`${CK}#m70`);
    expect(d.getOrCreateThread).toHaveBeenCalledWith(CK, 'm70', 'vuelo a Bilbao');
    db.close();
  });

  it('sin etiqueta guardada: principal y temas del foro con su nombre de siempre', async () => {
    const d = freshDaemon((k) =>
      k.endsWith(':1') ? { threadKey: `${CK}#main` } : { threadKey: `${CK}#t5` },
    );
    await resolveInboundThread(inb({ replyToMessageId: '1' }), CK, d);
    expect(d.getOrCreateThread).toHaveBeenLastCalledWith(CK, 'main', 'principal');
    await resolveInboundThread(inb({ replyToMessageId: '2' }), CK, d);
    expect(d.getOrCreateThread).toHaveBeenLastCalledWith(CK, 't5', 'hilo 5');
  });

  it('un hilo apuntado en memoria pero retirado por inactividad se reconstruye', async () => {
    const d = freshDaemon();
    d.messageThread.set(`${CK}:77`, `${CK}#m70`);
    const t = await resolveInboundThread(inb({ replyToMessageId: '77' }), CK, d);
    expect(t.key).toBe(`${CK}#m70`);
  });

  it('nunca salta a un hilo de otro chat', async () => {
    const d = freshDaemon(() => ({ threadKey: 'telegram:bot:99#m70' }));
    const t = await resolveInboundThread(inb({ replyToMessageId: '77' }), CK, d);
    expect(t.key).not.toContain('telegram:bot:99');
    expect(d.getOrCreateThread).not.toHaveBeenCalledWith(
      'telegram:bot:99',
      'm70',
      expect.anything(),
    );
  });

  it('el aviso de un objetivo sigue mandando antes que el mapa', async () => {
    const d = freshDaemon(() => ({ threadKey: `${CK}#m70` }));
    d.goalScopeBySentId.mockReturnValue(`${CK}#objetivos`);
    const t = await resolveInboundThread(inb({ replyToMessageId: '77' }), CK, d);
    expect(t.key).toBe(`${CK}#objetivos`);
  });
});
