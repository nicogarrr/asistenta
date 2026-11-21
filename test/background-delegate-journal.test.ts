import { describe, expect, it, vi } from 'vitest';
import { BackgroundDelegates, backgroundResultNote } from '../src/core/background-delegate.js';

const thread = (key = 'telegram:1:2#principal') => ({ key, generation: () => 1 });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('BackgroundDelegates con diario', () => {
  it('anota la subtarea al arrancar y la borra al terminar bien', async () => {
    const journal = { add: vi.fn(), remove: vi.fn(), complete: vi.fn() };
    const delegates = new BackgroundDelegates({ journal });
    delegates.start(thread(), { task: 'busca vuelos', run: async () => 'listo' }, async () => {});
    expect(journal.add).toHaveBeenCalledWith({
      id: expect.any(String),
      threadKey: 'telegram:1:2#principal',
      task: 'busca vuelos',
      startedAt: expect.any(Number),
    });
    await flush();
    expect(journal.remove).toHaveBeenCalledWith(expect.any(String));
  });

  it('borra la entrada también cuando la subtarea falla', async () => {
    const journal = { add: vi.fn(), remove: vi.fn(), complete: vi.fn() };
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
    expect(journal.remove).toHaveBeenCalledWith(expect.any(String));
  });

  it('borra la entrada cuando /stop la corta: una parada a propósito no se retoma', async () => {
    const journal = { add: vi.fn(), remove: vi.fn(), complete: vi.fn() };
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
    expect(journal.remove).toHaveBeenCalledWith(expect.any(String));
  });

  it('un diario que falla no impide arrancar ni entregar la subtarea', async () => {
    const journal = {
      add: () => {
        throw new Error('disco lleno');
      },
      remove: () => {
        throw new Error('disco lleno');
      },
      complete: () => {
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

  it('guarda rol y herramientas del original en el diario', () => {
    const journal = { add: vi.fn(), remove: vi.fn(), complete: vi.fn() };
    const delegates = new BackgroundDelegates({ journal });
    delegates.start(
      thread(),
      { task: 't', role: 'planner', tools: [], run: async () => 'ok' },
      async () => {},
    );
    expect(journal.add).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'planner', tools: [] }),
    );
  });

  it('si la entrega falla, la entrada se conserva con su resultado', async () => {
    const journal = { add: vi.fn(), remove: vi.fn(), complete: vi.fn() };
    const delegates = new BackgroundDelegates({ journal, onError: () => {} });
    delegates.start(thread(), { task: 't', run: async () => 'ok' }, async () => {
      throw new Error('cola caída');
    });
    await flush();
    expect(journal.complete).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('ok'),
    );
    expect(journal.remove).not.toHaveBeenCalled();
  });

  it('un resultado ya guardado se entrega sin repetir la subtarea', async () => {
    const journal = { add: vi.fn(), remove: vi.fn(), complete: vi.fn() };
    const delegates = new BackgroundDelegates({ journal });
    const run = vi.fn(async () => 'nuevo');
    const delivered: string[] = [];
    delegates.start(thread(), { task: 't', id: 'x1', result: 'nota guardada', run }, async (n) => {
      delivered.push(n);
    });
    await flush();
    expect(run).not.toHaveBeenCalled();
    expect(delivered).toEqual(['nota guardada']);
    expect(journal.remove).toHaveBeenCalledWith('x1');
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
