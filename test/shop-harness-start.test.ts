import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

// La tienda sintética (qa/shop-harness) la usan e2e-checkout y qa-stores-contract. Con un
// puerto ya ocupado (otra suite en la misma máquina), `start` no resolvía ni fallaba: el
// beforeAll se colgaba hasta su tope de 60 s. Ahora falla enseguida y `start(0)` da un puerto
// libre que el test lee del servidor.
type Shop = {
  start: (p: number) => Promise<{ close: () => void; address: () => AddressInfo | string | null }>;
};
const shop = (await import('../qa/shop-harness/shop.mjs' as string)) as Shop;

let busy: Server | undefined;
let started: { close: () => void } | undefined;
afterEach(async () => {
  started?.close();
  started = undefined;
  await new Promise<void>((r) => (busy ? busy.close(() => r()) : r()));
  busy = undefined;
});

const within = <T>(p: Promise<T>, ms: number): Promise<T | 'colgado'> =>
  Promise.race([p, new Promise<'colgado'>((r) => setTimeout(() => r('colgado'), ms))]);

describe('tienda sintética: start()', () => {
  it('con el puerto ocupado falla enseguida en vez de colgarse', async () => {
    busy = createServer();
    await new Promise<void>((r) => busy?.listen(0, '127.0.0.1', () => r()));
    const port = (busy.address() as AddressInfo).port;
    const out = await within(
      shop.start(port).then(
        () => 'arrancó',
        (e: NodeJS.ErrnoException) => e.code,
      ),
      3000,
    );
    expect(out).toBe('EADDRINUSE');
  });

  it('start(0) escucha en un puerto libre que se lee del servidor', async () => {
    const srv = await shop.start(0);
    started = srv;
    const port = (srv.address() as AddressInfo).port;
    expect(port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${port}/nada`);
    expect(res.status).toBe(404);
  });
});
