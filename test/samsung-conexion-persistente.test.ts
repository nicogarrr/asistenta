/**
 * Samsung: la conexión se queda abierta entre órdenes (como la LG en #1891).
 * Antes cada orden abría el WebSocket (TLS + «ms.channel.connect») y esperaba
 * 300 ms fijos antes de cerrar.
 */
import { describe, expect, it } from 'vitest';
import { SamsungSessionPool, type SamsungSocket, samsungDriver } from '../src/tv/samsung.js';

function fakeTv(opts: { token?: string; connectMs?: number } = {}) {
  const urls: string[] = [];
  const sent: string[] = [];
  const socks: Array<{
    fire: (ev: string) => void;
    state: { readyState: number };
    closed: boolean;
  }> = [];
  const factory = (url: string): SamsungSocket => {
    urls.push(url);
    const handlers: Record<string, ((x?: unknown) => void)[]> = {};
    const rec = {
      fire: (ev: string) => {
        for (const cb of handlers[ev] ?? []) cb();
      },
      state: { readyState: 1 },
      closed: false,
    };
    socks.push(rec);
    const sock = {
      on: (ev: string, cb: (x?: unknown) => void) => {
        const list = handlers[ev] ?? [];
        list.push(cb);
        handlers[ev] = list;
      },
      send: (d: string) => {
        sent.push(d);
        // Como una Tizen real: «ed.apps.launch» se acusa con data 200 (asis-computeruse-5).
        if (d.includes('ed.apps.launch')) {
          setTimeout(() => {
            const ack = JSON.stringify({ event: 'ed.apps.launch', data: 200, from: 'host' });
            for (const cb of handlers.message ?? []) cb(ack);
          }, 1);
        }
      },
      close: () => {
        rec.closed = true;
      },
      get readyState() {
        return rec.state.readyState;
      },
    } as unknown as SamsungSocket;
    setTimeout(() => {
      const msg = { event: 'ms.channel.connect', data: opts.token ? { token: opts.token } : {} };
      for (const cb of handlers.message ?? []) cb(JSON.stringify(msg));
    }, opts.connectMs ?? 5);
    return sock;
  };
  return { urls, sent, socks, factory };
}
const keys = (sent: string[]) =>
  sent.map((s) => (JSON.parse(s) as { params: { DataOfCmd?: string } }).params.DataOfCmd);
const conn = { host: '192.168.1.70', token: 'abc123', secure: true };

describe('Samsung con conexión persistente', () => {
  it('varias órdenes seguidas usan UNA conexión y no esperan los 300 ms', async () => {
    const tv = fakeTv({ token: 'abc123' });
    const pool = new SamsungSessionPool({ idleMs: 60_000 });
    const d = samsungDriver(conn, { socketFactory: tv.factory, pool });
    const t0 = performance.now();
    await d.volumeStep(-3);
    await d.key('DOWN');
    await d.key('ENTER');
    await d.launch?.('netflix');
    const ms = performance.now() - t0;
    expect(tv.urls).toHaveLength(1);
    expect(keys(tv.sent)).toEqual([
      'KEY_VOLDOWN',
      'KEY_VOLDOWN',
      'KEY_VOLDOWN',
      'KEY_DOWN',
      'KEY_ENTER',
      undefined,
    ]);
    expect(ms).toBeLessThan(300);
    pool.closeAll();
    await new Promise((r) => setTimeout(r, 0));
    expect(tv.socks[0]?.closed).toBe(true);
  });

  it('dos órdenes a la vez comparten la apertura', async () => {
    const tv = fakeTv({ connectMs: 20 });
    const pool = new SamsungSessionPool();
    const d = samsungDriver(conn, { socketFactory: tv.factory, pool });
    await Promise.all([d.key('UP'), d.key('LEFT')]);
    expect(tv.urls).toHaveLength(1);
    expect(keys(tv.sent).sort()).toEqual(['KEY_LEFT', 'KEY_UP']);
    pool.closeAll();
  });

  it('si la tele cierra la conexión (apagado, reposo) la siguiente orden abre otra', async () => {
    const tv = fakeTv();
    const pool = new SamsungSessionPool();
    const d = samsungDriver(conn, { socketFactory: tv.factory, pool });
    await d.key('UP');
    tv.socks[0]?.fire('close');
    await d.key('DOWN');
    expect(tv.urls).toHaveLength(2);
    expect(pool.size()).toBe(1);
    pool.closeAll();
  });

  it('nunca manda por un socket que ya no está abierto (las teclas se perderían)', async () => {
    const tv = fakeTv();
    const pool = new SamsungSessionPool();
    const d = samsungDriver(conn, { socketFactory: tv.factory, pool });
    await d.key('UP');
    const first = tv.socks[0];
    if (first) first.state.readyState = 3; // cerrado sin evento
    await d.key('DOWN');
    expect(tv.urls).toHaveLength(2);
    expect(keys(tv.sent)).toEqual(['KEY_UP', 'KEY_DOWN']);
    pool.closeAll();
  });

  it('se cierra sola tras el tiempo sin uso', async () => {
    const tv = fakeTv();
    const pool = new SamsungSessionPool({ idleMs: 30 });
    await samsungDriver(conn, { socketFactory: tv.factory, pool }).key('HOME');
    await new Promise((r) => setTimeout(r, 80));
    expect(tv.socks[0]?.closed).toBe(true);
    expect(pool.size()).toBe(0);
  });

  it('un token nuevo se avisa una vez para guardarlo', async () => {
    const tv = fakeTv({ token: 'nuevo9' });
    const pool = new SamsungSessionPool();
    const saved: string[] = [];
    const d = samsungDriver(
      { host: '192.168.1.70', secure: true },
      { socketFactory: tv.factory, pool, onToken: (t) => void saved.push(t) },
    );
    await d.key('UP');
    await d.key('UP');
    expect(saved).toEqual(['nuevo9']);
    pool.closeAll();
  });

  it('sin pool (pa tv) sigue abriendo y cerrando como siempre', async () => {
    const tv = fakeTv();
    const d = samsungDriver(conn, { socketFactory: tv.factory, graceMs: 0 });
    await d.key('UP');
    await d.key('UP');
    expect(tv.urls).toHaveLength(2);
    expect(tv.socks.every((s) => s.closed)).toBe(true);
  });
});
