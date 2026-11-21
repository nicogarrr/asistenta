import { describe, expect, it, vi } from 'vitest';
import { BackgroundDelegates, backgroundResultNote } from '../src/core/background-delegate.js';

const thread = (key = 'telegram:1:2#principal') => ({ key, generation: () => 1 });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('BackgroundDelegates con diario', () => {
  it('anota la subtarea al arrancar y la borra al terminar bien', async () => {
    const journal = { add: vi.fn(), remove: vi.fn() };
    const delegates = new BackgroundDelegates({ journal });
    delegates.start(thread(), { task: 'busca vuelos', run: async () => 'listo' }, async () => {});
    expect(journal.add).toHaveBeenCalledWith({
      threadKey: 'telegram:1:2#principal',
      task: 'busca vuelos',
      startedAt: expect.any(Number),
    });
    await flush();
    expect(journal.remove).toHaveBeenCalledWith('telegram:1:2#principal', 'busca vuelos');
  });

  it('borra la entrada también cuando la subtarea falla', async () => {
    const journal = { add: vi.fn(), remove: vi.fn() };
    const delegates = new BackgroundDelegates({ journal });
    delegates.start(
      thread(),
      {
        task: 'busca vuelos',
        run: async () => {
          throw new Error('se rompió');
        },
      },
      async () => {},
    );
    await flush();
    expect(journal.remove).toHaveBeenCalledWith('telegram:1:2#principal', 'busca vuelos');
  });

  it('borra la entrada cuando /stop la corta: una parada a propósito no se retoma', async () => {
    const journal = { add: vi.fn(), remove: vi.fn() };
    const delegates = new BackgroundDelegates({ journal });
    delegates.start(
      thread(),
      {
        task: 'busca vuelos',
        run: (signal) =>
          new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('abortado')), { once: true });
          }),
      },
      async () => {},
    );
    delegates.abortThread('telegram:1:2#principal');
    await flush();
    expect(journal.remove).toHaveBeenCalledWith('telegram:1:2#principal', 'busca vuelos');
  });

  it('un diario que falla no impide arrancar ni entregar la subtarea', async () => {
    const journal = {
      add: () => {
        throw new Error('disco lleno');
      },
      remove: () => {
        throw new Error('disco lleno');
      },
    };
    const delegates = new BackgroundDelegates({ journal, onError: () => {} });
    const delivered: string[] = [];
    const started = delegates.start(
      thread(),
      { task: 'busca vuelos', run: async () => 'listo' },
      async (note) => {
        delivered.push(note);
      },
    );
    expect(started).toBe(true);
    await flush();
    expect(delivered).toHaveLength(1);
  });

  it('una subtarea retomada tras un reinicio lo dice en el aviso', () => {
    const note = backgroundResultNote('busca vuelos', 'hay uno a 50 €', false, false, true);
    expect(note).toContain('se cortó con un reinicio de Asistenta y se ha retomado sola');
    const normal = backgroundResultNote('busca vuelos', 'hay uno a 50 €');
    expect(normal).not.toContain('reinicio');
  });

  it('sin diario funciona como siempre', async () => {
    const delegates = new BackgroundDelegates();
    const delivered: string[] = [];
    delegates.start(thread(), { task: 't', run: async () => 'ok' }, async (note) => {
      delivered.push(note);
    });
    await flush();
    expect(delivered).toHaveLength(1);
  });
});
