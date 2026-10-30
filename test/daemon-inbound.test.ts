import { describe, expect, it } from 'vitest';
import {
  isDuplicateUpdate,
  queueThreadTurn,
  SEEN_MESSAGE_MAX,
  SEEN_MESSAGE_TTL_MS,
} from '../src/daemon/inbound.js';

describe('isDuplicateUpdate (update repetido de Telegram)', () => {
  it('la primera vez no es duplicado y queda apuntado', () => {
    const seen = new Map<string, number>();
    expect(isDuplicateUpdate(seen, 'c:1', 1000)).toBe(false);
    expect(seen.get('c:1')).toBe(1000);
  });
  it('el mismo id dentro de la hora es duplicado y no renueva la marca', () => {
    const seen = new Map<string, number>();
    isDuplicateUpdate(seen, 'c:1', 1000);
    expect(isDuplicateUpdate(seen, 'c:1', 1000 + SEEN_MESSAGE_TTL_MS - 1)).toBe(true);
    expect(seen.get('c:1')).toBe(1000);
  });
  it('pasada la hora vuelve a contar como nuevo', () => {
    const seen = new Map<string, number>();
    isDuplicateUpdate(seen, 'c:1', 1000);
    expect(isDuplicateUpdate(seen, 'c:1', 1000 + SEEN_MESSAGE_TTL_MS)).toBe(false);
    expect(seen.get('c:1')).toBe(1000 + SEEN_MESSAGE_TTL_MS);
  });
  it('el mismo messageId en otro chat no es duplicado', () => {
    const seen = new Map<string, number>();
    isDuplicateUpdate(seen, 'a:1', 1);
    expect(isDuplicateUpdate(seen, 'b:1', 2)).toBe(false);
  });
  it('al pasar el tope olvida el más antiguo', () => {
    const seen = new Map<string, number>();
    for (let i = 0; i <= SEEN_MESSAGE_MAX; i++) isDuplicateUpdate(seen, `c:${i}`, 5);
    expect(seen.size).toBe(SEEN_MESSAGE_MAX);
    expect(seen.has('c:0')).toBe(false);
    expect(isDuplicateUpdate(seen, 'c:0', 6)).toBe(false);
  });
});

describe('queueThreadTurn (cola por hilo)', () => {
  const thread = () => ({ tail: Promise.resolve() as Promise<unknown>, generation: 0 });

  it('dentro de un hilo corre en orden aunque el primero tarde más', async () => {
    const t = thread();
    const order: string[] = [];
    const a = queueThreadTurn(t, async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push('a');
      return 'A';
    });
    const b = queueThreadTurn(t, async () => {
      order.push('b');
      return 'B';
    });
    expect(await Promise.all([a, b])).toEqual(['A', 'B']);
    expect(order).toEqual(['a', 'b']);
  });

  it('/stop (generación nueva) descarta lo encolado que no ha empezado', async () => {
    const t = thread();
    let release!: () => void;
    const first = queueThreadTurn(
      t,
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    let ran = false;
    const second = queueThreadTurn(t, async () => {
      ran = true;
    });
    await new Promise((r) => setTimeout(r, 0)); // el primero ya está corriendo
    t.generation++;
    release();
    await first;
    expect(await second).toBeUndefined();
    expect(ran).toBe(false);
  });

  it('un fallo no rompe la cola: el siguiente turno corre', async () => {
    const t = thread();
    const bad = queueThreadTurn(t, async () => {
      throw new Error('boom');
    });
    await expect(bad).rejects.toThrow('boom');
    expect(await queueThreadTurn(t, async () => 7)).toBe(7);
  });

  it('hilos distintos no se esperan entre sí', async () => {
    const a = thread();
    const b = thread();
    queueThreadTurn(a, () => new Promise(() => {}));
    expect(await queueThreadTurn(b, async () => 'libre')).toBe('libre');
  });
});
