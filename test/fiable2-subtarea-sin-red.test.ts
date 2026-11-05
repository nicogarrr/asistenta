import { describe, expect, it } from 'vitest';
import { BackgroundDelegates } from '../src/core/background-delegate.js';

// Una subtarea en segundo plano («búscame vuelos y me dices») que pillaba el PC sin
// internet llegaba como «no terminó bien: fetch failed» y había que volver a pedirla.
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const thread = (gen = { n: 0 }) => ({ key: 'chat#main', generation: () => gen.n });
const OUTAGE = 'TypeError: fetch failed (getaddrinfo ENOTFOUND api.example)';

describe('subtarea en segundo plano sin red', () => {
  it('se repite sola tras el corte y el resultado llega, marcado con retraso', async () => {
    const waits: number[] = [];
    const bg = new BackgroundDelegates({
      retryDelays: [60_000, 120_000],
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    let calls = 0;
    const notes: string[] = [];
    bg.start(
      thread(),
      {
        task: 'busca vuelos',
        run: async () => {
          calls++;
          if (calls < 3) throw new Error(OUTAGE);
          return 'Iberia 89 €';
        },
      },
      async (n) => {
        notes.push(n);
      },
    );
    await flush();
    expect(calls).toBe(3);
    expect(waits).toEqual([60_000, 120_000]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).not.toMatch(/no terminó bien/);
    expect(notes[0]).toMatch(/con retraso/);
    expect(notes[0]).toMatch(/Iberia 89 €$/);
    expect(bg.count('chat#main')).toBe(0);
  });

  it('si el corte dura más que los reintentos, avisa del fallo (una vez)', async () => {
    const bg = new BackgroundDelegates({ retryDelays: [1, 1], sleep: async () => {} });
    let calls = 0;
    const notes: string[] = [];
    bg.start(
      thread(),
      {
        task: 'x',
        run: async () => {
          calls++;
          throw new Error(OUTAGE);
        },
      },
      async (n) => {
        notes.push(n);
      },
    );
    await flush();
    expect(calls).toBe(3);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/no terminó bien/);
  });

  it('un fallo que no es de red no se repite', async () => {
    const bg = new BackgroundDelegates({ retryDelays: [1, 1], sleep: async () => {} });
    let calls = 0;
    const notes: string[] = [];
    bg.start(
      thread(),
      {
        task: 'x',
        run: async () => {
          calls++;
          throw new Error('la página no existe');
        },
      },
      async (n) => {
        notes.push(n);
      },
    );
    await flush();
    expect(calls).toBe(1);
    expect(notes[0]).toMatch(/no terminó bien/);
  });

  it('/stop durante la espera la corta y no entrega nada', async () => {
    let wake: () => void = () => {};
    const bg = new BackgroundDelegates({
      retryDelays: [60_000],
      sleep: (_ms, signal) =>
        new Promise<void>((resolve) => {
          wake = resolve;
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    });
    let calls = 0;
    const notes: string[] = [];
    bg.start(
      thread(),
      {
        task: 'x',
        run: async () => {
          calls++;
          throw new Error(OUTAGE);
        },
      },
      async (n) => {
        notes.push(n);
      },
    );
    await flush();
    expect(bg.count('chat#main')).toBe(1);
    bg.abortThread('chat#main');
    await flush();
    wake();
    await flush();
    expect(calls).toBe(1);
    expect(notes).toEqual([]);
    expect(bg.count('chat#main')).toBe(0);
  });

  it('el daemon pasa las esperas del reintento automático', async () => {
    const { readFileSync } = await import('node:fs');
    const cli = readFileSync('src/cli.ts', 'utf8');
    expect(cli).toContain('retryDelays: autoRetryOn ? AUTO_RETRY_DELAYS_MS : []');
  });
});
