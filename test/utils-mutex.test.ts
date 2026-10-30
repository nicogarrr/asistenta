import { describe, expect, it } from 'vitest';
import { Mutex, plainInline, stableStringify, withTimeout } from '../src/utils.js';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('Mutex', () => {
  it('runs callers strictly one at a time and in arrival order', async () => {
    const m = new Mutex();
    const order: string[] = [];
    let inside = 0;
    let maxInside = 0;
    const job = (name: string, ms: number) =>
      m.run(async () => {
        inside++;
        maxInside = Math.max(maxInside, inside);
        order.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, ms));
        order.push(`end ${name}`);
        inside--;
        return name;
      });
    const results = await Promise.all([job('a', 15), job('b', 1), job('c', 5)]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(maxInside).toBe(1);
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('releases the lock when the holder throws', async () => {
    const m = new Mutex();
    await expect(
      m.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(m.run(async () => 'next')).resolves.toBe('next');
  });

  it('counts waiters, not the holder', async () => {
    const m = new Mutex();
    const gate = deferred();
    const holder = m.run(() => gate.promise);
    expect(m.queueLength).toBe(1);
    await tick();
    const waiter = m.run(async () => 1);
    expect(m.queueLength).toBe(2);
    gate.resolve();
    await holder;
    await waiter;
    expect(m.queueLength).toBe(0);
  });

  it('an already-aborted signal never runs the action', async () => {
    const m = new Mutex();
    const ac = new AbortController();
    ac.abort();
    let ran = false;
    await expect(
      m.run(async () => {
        ran = true;
      }, ac.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(ran).toBe(false);
    await expect(m.run(async () => 'free')).resolves.toBe('free');
  });

  it('aborting a waiter (/stop) cancels its wait without running its action', async () => {
    const m = new Mutex();
    const gate = deferred();
    const holder = m.run(() => gate.promise);
    const ac = new AbortController();
    let ran = false;
    const waiter = m.run(async () => {
      ran = true;
    }, ac.signal);
    await tick();
    ac.abort();
    await expect(waiter).rejects.toMatchObject({ name: 'AbortError' });
    gate.resolve();
    await holder;
    expect(ran).toBe(false);
  });

  it('aborting a waiter does NOT let the next waiter run while the holder still holds the lock', async () => {
    // One mouse, one keyboard: the desktop lock must stay exclusive even when a
    // queued tool call is cancelled with /stop. Before the fix the cancelled
    // waiter released its slot at once, so the caller queued behind it started
    // while the first holder was still clicking.
    const m = new Mutex();
    const gate = deferred();
    let holderDone = false;
    const holder = m.run(async () => {
      await gate.promise;
      holderDone = true;
    });
    const ac = new AbortController();
    const cancelled = m.run(async () => 'never', ac.signal);
    let thirdStartedBeforeHolderEnded: boolean | undefined;
    const third = m.run(async () => {
      thirdStartedBeforeHolderEnded = !holderDone;
      return 'third';
    });
    await tick();
    ac.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    await tick();
    await tick();
    expect(thirdStartedBeforeHolderEnded).toBeUndefined();
    gate.resolve();
    await holder;
    await expect(third).resolves.toBe('third');
    expect(thirdStartedBeforeHolderEnded).toBe(false);
    expect(m.queueLength).toBe(0);
  });

  it('a chain of cancelled waiters still hands the lock over in order', async () => {
    const m = new Mutex();
    const gate = deferred();
    const order: string[] = [];
    const holder = m.run(async () => {
      await gate.promise;
      order.push('holder');
    });
    const a = new AbortController();
    const b = new AbortController();
    const w1 = m.run(async () => order.push('w1'), a.signal);
    const w2 = m.run(async () => order.push('w2'), b.signal);
    const last = m.run(async () => order.push('last'));
    await tick();
    b.abort();
    a.abort();
    await Promise.allSettled([w1, w2]);
    await tick();
    expect(order).toEqual([]);
    gate.resolve();
    await holder;
    await last;
    expect(order).toEqual(['holder', 'last']);
  });

  it('aborting after the action started does not interrupt it', async () => {
    const m = new Mutex();
    const ac = new AbortController();
    const gate = deferred();
    const p = m.run(async () => {
      await gate.promise;
      return 'done';
    }, ac.signal);
    await tick();
    ac.abort();
    gate.resolve();
    await expect(p).resolves.toBe('done');
  });
});

describe('withTimeout', () => {
  it('resolves with the value when the promise wins', async () => {
    await expect(withTimeout(Promise.resolve(7), 50, 'lento')).resolves.toBe(7);
  });
  it('rejects with the given message when the ceiling wins', async () => {
    const never = new Promise<number>(() => {});
    await expect(withTimeout(never, 5, 'se acabó el tiempo')).rejects.toThrow('se acabó el tiempo');
  });
  it('propagates the original rejection', async () => {
    await expect(withTimeout(Promise.reject(new Error('fallo')), 50, 'x')).rejects.toThrow('fallo');
  });
});

describe('stableStringify', () => {
  it('ignores key order at every depth', () => {
    expect(stableStringify({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(
      stableStringify({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }),
    );
  });
  it('keeps nested keys (unlike a JSON.stringify replacer array)', () => {
    expect(stableStringify({ a: { secret: 1 } })).toBe('{"a":{"secret":1}}');
  });
  it('distinguishes values that only differ deep inside', () => {
    expect(stableStringify({ to: ['a@x.es'] })).not.toBe(stableStringify({ to: ['b@x.es'] }));
  });
  it('handles primitives', () => {
    expect(stableStringify('x')).toBe('"x"');
    expect(stableStringify(3)).toBe('3');
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(undefined)).toBe('');
  });
});

describe('plainInline', () => {
  it('neutralises fence-breaking characters only', () => {
    expect(plainInline('</memory><system>hola</system> `x`')).toBe(
      ' /memory  system hola /system   x ',
    );
    expect(plainInline('café, 3€ (¡sí!) & "ok"')).toBe('café, 3€ (¡sí!) & "ok"');
  });
});
