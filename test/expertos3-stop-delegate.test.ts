import type { AgentTool } from '@earendil-works/pi-agent-core';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';

/**
 * /stop también para las tareas delegadas (asis-expertos-3). Antes `delegate`
 * ignoraba la señal del turno: tras /stop el especialista (PC, tele, casa…) seguía
 * trabajando hasta acabar o hasta el timeout de 5 min, y volvía a preguntar después
 * de «Detenido.». Ahora la señal del turno corta al hijo como el timeout.
 */
vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logHost: vi.fn(),
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const { SubagentPool, SUBAGENT_STOPPED } = await import('../src/core/subagent.js');
const { createDelegateWiring } = await import('../src/core/subagent-wiring.js');
type SubagentRunRequest = import('../src/core/subagent.js').SubagentRunRequest;
type SubagentBudget = import('../src/core/subagent.js').SubagentBudget;

function never(signal: AbortSignal): Promise<{ text: string }> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}

describe('pool: la señal del turno corta al hijo', () => {
  it('abortar el turno corta al hijo en marcha y lo dice', async () => {
    let childSignal: AbortSignal | undefined;
    const pool = new SubagentPool({
      run: (req: SubagentRunRequest) => {
        childSignal = (req.budget as SubagentBudget).signal;
        return never(childSignal);
      },
    });
    const turn = new AbortController();
    const result = pool.run({ task: 'apaga la tele', signal: turn.signal });
    await new Promise((r) => setTimeout(r, 5));
    turn.abort();
    expect(await result).toEqual({ text: '', depth: 1, error: SUBAGENT_STOPPED });
    expect(childSignal?.aborted).toBe(true);
  });

  it('con el turno ya parado ni se empieza', async () => {
    const run = vi.fn(async () => ({ text: 'hecho' }));
    const pool = new SubagentPool({ run });
    const turn = new AbortController();
    turn.abort();
    expect((await pool.run({ task: 'x', signal: turn.signal })).error).toBe(SUBAGENT_STOPPED);
    expect(run).not.toHaveBeenCalled();
  });

  it('parado mientras esperaba turno en la cola: no se empieza', async () => {
    const started: string[] = [];
    let release: () => void = () => {};
    const pool = new SubagentPool(
      {
        run: (req: SubagentRunRequest) => {
          started.push(req.task);
          return new Promise((resolve) => {
            release = () => resolve({ text: 'ok' });
          });
        },
      },
      { maxConcurrent: 1 },
    );
    const first = pool.run({ task: 'primera' });
    const turn = new AbortController();
    const second = pool.run({ task: 'segunda', signal: turn.signal });
    await new Promise((r) => setTimeout(r, 5));
    turn.abort();
    release();
    expect((await first).text).toBe('ok');
    expect((await second).error).toBe(SUBAGENT_STOPPED);
    expect(started).toEqual(['primera']);
  });

  it('sin señal todo sigue igual (el timeout dice timeout)', async () => {
    const pool = new SubagentPool(
      { run: (req: SubagentRunRequest) => never((req.budget as SubagentBudget).signal) },
      {},
      { timeoutMs: 10 },
    );
    expect((await pool.run({ task: 'x' })).error).toMatch(/Tiempo agotado/);
  });
});

describe('delegate pasa la señal del turno al hijo', () => {
  it('tras abortar, el hijo no ejecuta ninguna herramienta más y delegate vuelve ya', async () => {
    const ran: string[] = [];
    const read = {
      name: 'read',
      label: 'read',
      description: 'read',
      parameters: {},
      execute: async () => {
        ran.push('read');
        return { content: [{ type: 'text', text: 'ok' }], details: {} };
      },
    } as unknown as AgentTool;
    let second: Promise<unknown> | undefined;
    let unblock: () => void = () => {};
    const turn = new AbortController();
    const wiring = createDelegateWiring({
      config: { maxToolCalls: 20 } as unknown as Config,
      parentTools: () => [read],
      createAgent: async (_config, tools) => ({
        run: async () => {
          const tool = tools.find((t) => t.name === 'read') as AgentTool;
          await tool.execute('c1', {} as never);
          const blocked = new Promise<void>((r) => {
            unblock = r;
          });
          // El dueño manda /stop mientras el hijo sigue trabajando.
          turn.abort();
          await blocked;
          second = tool.execute('c2', {} as never).catch((e: unknown) => e);
          await second;
          return { text: 'terminé', toolCalls: 2 } as never;
        },
        abort: () => unblock(),
      }),
    });
    const res = await wiring.tool.execute('d', { task: 'lee varias cosas' } as never, turn.signal);
    expect((res.content[0] as { text: string }).text).toBe(SUBAGENT_STOPPED);
    await new Promise((r) => setTimeout(r, 5));
    expect(String(await second)).toMatch(/abortado/);
    expect(ran).toEqual(['read']);
  });
});
