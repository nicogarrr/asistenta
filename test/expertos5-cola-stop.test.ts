import { describe, expect, it } from 'vitest';
import {
  SUBAGENT_STOPPED,
  type SubagentBudget,
  type SubagentDeps,
  SubagentPool,
} from '../src/core/subagent.js';

/**
 * Una tarea delegada que espera turno en la cola (ya hay tantos hijos como permite el
 * pool, p. ej. de otro chat) y cuyo turno se para con /stop: antes seguía en la cola
 * hasta que se liberara un hueco, y el /stop no volvía hasta entonces. Ahora sale de la
 * cola al momento, sin empezar. Solo puede parar antes; nunca deja hacer nada más.
 */
function blockingDeps(): { deps: SubagentDeps; started: string[] } {
  const started: string[] = [];
  const deps: SubagentDeps = {
    run: (req) => {
      started.push(req.task);
      return new Promise((resolve) => {
        (req.budget as SubagentBudget).signal.addEventListener(
          'abort',
          () => resolve({ text: 'cortado' }),
          {
            once: true,
          },
        );
      });
    },
  };
  return { deps, started };
}

describe('pool de subagentes: /stop con la tarea esperando turno', () => {
  it('sale de la cola al momento y no se empieza nunca', async () => {
    const { deps, started } = blockingDeps();
    const pool = new SubagentPool(deps, { maxConcurrent: 1 }, { timeoutMs: 60_000 });
    const otherChat = new AbortController();
    const first = pool.run({ task: 'otro chat', parentDepth: 0, signal: otherChat.signal });

    const turn = new AbortController();
    const queued = pool.run({ task: 'en cola', parentDepth: 0, signal: turn.signal });
    await new Promise((r) => setTimeout(r, 5));
    expect(started).toEqual(['otro chat']);

    turn.abort();
    const outcome = await Promise.race([
      queued.then((r) => r.error),
      new Promise((r) => setTimeout(() => r('sigue en la cola'), 200)),
    ]);
    expect(outcome).toBe(SUBAGENT_STOPPED);

    // El hueco sigue siendo del primero; al terminar, la cola no arranca la parada.
    otherChat.abort();
    await first;
    await new Promise((r) => setTimeout(r, 5));
    expect(started).toEqual(['otro chat']);
  });

  it('la que espera sin parar sigue entrando en orden cuando hay hueco', async () => {
    const { deps, started } = blockingDeps();
    const pool = new SubagentPool(deps, { maxConcurrent: 1 }, { timeoutMs: 60_000 });
    const a = new AbortController();
    const first = pool.run({ task: 'a', parentDepth: 0, signal: a.signal });
    const stopped = new AbortController();
    const second = pool.run({ task: 'b', parentDepth: 0, signal: stopped.signal });
    const c = new AbortController();
    const third = pool.run({ task: 'c', parentDepth: 0, signal: c.signal });
    await new Promise((r) => setTimeout(r, 5));
    stopped.abort();
    expect((await second).error).toBe(SUBAGENT_STOPPED);
    a.abort();
    await first;
    await new Promise((r) => setTimeout(r, 5));
    expect(started).toEqual(['a', 'c']);
    c.abort();
    await third;
    // Hueco libre de nuevo: la siguiente entra sin esperar (el contador no se descuadra).
    const pool2Started = started.length;
    const x = new AbortController();
    const one = pool.run({ task: 'x', parentDepth: 0, signal: x.signal });
    await new Promise((r) => setTimeout(r, 5));
    expect(started.length).toBe(pool2Started + 1);
    x.abort();
    await one;
  });
});
