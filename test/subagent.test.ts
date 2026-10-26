import { describe, expect, it } from 'vitest';
import {
  SUBAGENT_DEFAULT_LIMITS,
  SUBAGENT_DEFAULT_TIMEOUT_MS,
  type SubagentBudget,
  type SubagentDeps,
  SubagentPool,
} from '../src/core/subagent.js';
import { createDelegateTool, DELEGATE_TOOL_NAME } from '../src/tools/delegate.js';

/** Deja correr las microtareas pendientes (cola y arranque de tareas). */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('SubagentPool', () => {
  it('usa los limites por defecto 2/2/25 y cinco minutos de timeout', () => {
    const pool = new SubagentPool({ run: async () => ({ text: 'ok' }) });

    expect(pool.limits).toEqual({ maxDepth: 2, maxConcurrent: 2, maxToolCalls: 25 });
    expect(pool.limits).toEqual(SUBAGENT_DEFAULT_LIMITS);
    expect(pool.timeoutMs).toBe(SUBAGENT_DEFAULT_TIMEOUT_MS);
  });

  it('rechaza por encima de la profundidad maxima sin llamar al hijo', async () => {
    let calls = 0;
    const deps: SubagentDeps = {
      run: async ({ depth }) => {
        calls++;
        return { text: `hijo-${depth}` };
      },
    };
    const pool = new SubagentPool(deps);

    // parentDepth 1 -> el hijo esta en profundidad 2, el limite por defecto.
    await expect(pool.run({ task: 'permitida', parentDepth: 1 })).resolves.toEqual({
      text: 'hijo-2',
      depth: 2,
    });

    // parentDepth 2 -> profundidad 3, se rechaza y no consume ni ejecuta.
    const hondo = await pool.run({ task: 'demasiado honda', parentDepth: 2 });
    expect(hondo.text).toBe('');
    expect(hondo.depth).toBe(3);
    expect(hondo.error).toMatch(/profundidad/i);
    expect(calls).toBe(1);
  });

  it('limita a dos en paralelo y hace esperar a la tercera en FIFO', async () => {
    const gates = [deferred(), deferred(), deferred()];
    const started: string[] = [];
    let active = 0;
    let peak = 0;

    const deps: SubagentDeps = {
      run: async ({ task }) => {
        const index = Number(task.slice(1));
        started.push(task);
        active++;
        peak = Math.max(peak, active);
        try {
          await gates[index]?.promise;
        } finally {
          active--;
        }
        return { text: `fin-${task}` };
      },
    };
    const pool = new SubagentPool(deps, { maxConcurrent: 2 });

    const first = pool.run({ task: 't0' });
    const second = pool.run({ task: 't1' });
    const third = pool.run({ task: 't2' });

    await flush();
    expect(started).toEqual(['t0', 't1']);
    expect(peak).toBe(2);

    // Al terminar una, solo entra la tercera; nunca se supera el cupo.
    gates[0]?.resolve();
    await expect(first).resolves.toEqual({ text: 'fin-t0', depth: 1 });
    await flush();
    expect(started).toEqual(['t0', 't1', 't2']);
    expect(peak).toBe(2);

    gates[1]?.resolve();
    gates[2]?.resolve();
    await expect(second).resolves.toEqual({ text: 'fin-t1', depth: 1 });
    await expect(third).resolves.toEqual({ text: 'fin-t2', depth: 1 });
  });

  it('corta por timeout, aborta la senal interna y no lanza', async () => {
    let signal: AbortSignal | undefined;
    const deps: SubagentDeps = {
      run: async ({ budget }) => {
        signal = (budget as SubagentBudget).signal;
        return new Promise(() => {});
      },
    };
    const pool = new SubagentPool(deps, { timeoutMs: 25 });

    const result = await pool.run({ task: 'colgada' });

    expect(result.text).toBe('');
    expect(result.depth).toBe(1);
    expect(result.error).toMatch(/tiempo agotado|timeout/i);
    expect(signal?.aborted).toBe(true);
  });

  it('propaga errores del hijo como resultado, tanto rechazos como error devuelto', async () => {
    const deps: SubagentDeps = {
      run: async ({ task }) => {
        if (task === 'lanza') throw new Error('boom');
        if (task === 'devuelve') return { text: 'parcial', error: 'fallo del hijo' };
        return { text: 'bien' };
      },
    };
    const pool = new SubagentPool(deps);

    await expect(pool.run({ task: 'lanza' })).resolves.toEqual({
      text: '',
      depth: 1,
      error: 'boom',
    });
    await expect(pool.run({ task: 'devuelve' })).resolves.toEqual({
      text: '',
      depth: 1,
      error: 'fallo del hijo',
    });
    await expect(pool.run({ task: 'ok' })).resolves.toEqual({ text: 'bien', depth: 1 });
  });

  it('entrega el presupuesto y falla si el hijo supera maxToolCalls', async () => {
    let seen: SubagentBudget | undefined;
    const deps: SubagentDeps = {
      run: async ({ budget }) => {
        seen = budget as SubagentBudget;
        return { text: 'ok', toolCalls: 26 };
      },
    };
    const pool = new SubagentPool(deps, { maxToolCalls: 25 });

    const result = await pool.run({ task: 'gasta', tools: ['read'] });

    expect(seen?.maxToolCalls).toBe(25);
    expect(seen?.tools).toEqual(['read']);
    expect(result.text).toBe('');
    expect(result.error).toMatch(/limite/i);
  });
});

describe('createDelegateTool', () => {
  it('declara los tips de uso y el modo paralelo', () => {
    const pool = new SubagentPool({ run: async () => ({ text: 'ok' }) });
    const tool = createDelegateTool(pool, () => 0);

    expect(tool.name).toBe(DELEGATE_TOOL_NAME);
    expect(tool.executionMode).toBe('parallel');
    expect(tool.description).toMatch(/delega/i);
    expect(tool.description).toMatch(/paralelizable|lectura larga/i);
    expect(tool.description).toMatch(/sin efectos secundarios/i);
    expect(tool.description).toMatch(/no hereda aprobaciones/i);
    expect(tool.description).toMatch(/historial/i);
  });

  it('delega con la profundidad del padre y devuelve texto y detalles', async () => {
    let receivedDepth = 0;
    let receivedTools: string[] | undefined;
    const deps: SubagentDeps = {
      run: async (request) => {
        receivedDepth = request.depth;
        receivedTools = [...(request.budget as SubagentBudget).tools];
        return { text: 'resumen del hijo' };
      },
    };
    const pool = new SubagentPool(deps);
    const tool = createDelegateTool(pool, () => 1);

    const result = await tool.execute('d1', {
      task: 'compara tres fuentes',
      tools: ['read', 'fetch'],
    });

    expect(receivedDepth).toBe(2);
    expect(receivedTools).toEqual(['read', 'fetch']);
    expect(result.content).toEqual([{ type: 'text', text: 'resumen del hijo' }]);
    expect(result.details).toEqual({ depth: 2 });
  });

  it('muestra el error del subagente en el contenido y en details', async () => {
    const pool = new SubagentPool({
      run: async () => {
        throw new Error('sin red');
      },
    });
    const tool = createDelegateTool(pool, () => 0);

    const result = await tool.execute('d2', { task: 'falla' });

    expect(result.content).toEqual([{ type: 'text', text: 'sin red' }]);
    expect(result.details).toEqual({ depth: 1, error: 'sin red' });
  });
});
