import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { checkTelegramToken, SERVE_TELEGRAM_RETRY_DELAYS_MS } from '../src/startup.js';

const ok = () => new Response(JSON.stringify({ ok: true, result: { id: 1 } }));
const sinRed = () => {
  throw new TypeError('fetch failed');
};

describe('arranque tras encender el PC: la red aún no está', () => {
  it('reintenta con esperas hasta que el Wi-Fi conecta, sin cerrar Asistenta', async () => {
    let n = 0;
    const fetcher = vi.fn(async () => (++n <= 2 ? sinRed() : ok()));
    const sleep = vi.fn(async (_ms: number) => {});
    await checkTelegramToken('t', fetcher as typeof fetch, { delaysMs: [5, 10, 20], sleep });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([5, 10]);
  });

  it('un fallo de Telegram por su lado (5xx) también se reintenta', async () => {
    let n = 0;
    const fetcher = async () => (++n === 1 ? new Response('', { status: 502 }) : ok());
    await checkTelegramToken('t', fetcher as typeof fetch, {
      delaysMs: [1],
      sleep: async () => {},
    });
    expect(n).toBe(2);
  });

  it('si la red no vuelve, al final da el mismo aviso claro de siempre', async () => {
    const fetcher = vi.fn(async () => sinRed());
    await expect(
      checkTelegramToken('t', fetcher as typeof fetch, { delaysMs: [1, 1], sleep: async () => {} }),
    ).rejects.toThrow('No puedo conectar con Telegram');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('un token mal puesto no se reintenta', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 401 }));
    const sleep = vi.fn(async (_ms: number) => {});
    await expect(
      checkTelegramToken('t', fetcher as typeof fetch, { delaysMs: [1, 1], sleep }),
    ).rejects.toThrow('no es válido');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('sin opciones (pa iniciar, pa doctor) sigue siendo un solo intento', async () => {
    const fetcher = vi.fn(async () => sinRed());
    await expect(checkTelegramToken('t', fetcher as typeof fetch)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('pa serve espera hasta poco más de un minuto en total', () => {
    const total = SERVE_TELEGRAM_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(30_000);
    expect(total).toBeLessThanOrEqual(90_000);
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli).toMatch(
      /checkTelegramToken\(token, fetch, \{\s*delaysMs: SERVE_TELEGRAM_RETRY_DELAYS_MS/,
    );
  });
});
