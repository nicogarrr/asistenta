import type { AgentTool } from '@earendil-works/pi-agent-core';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';

/**
 * Pregunta abierta de un especialista que caduca o termina (asis-expertos-4). Antes,
 * si el especialista llegaba a su timeout mientras esperaba tu «Permitir», la tarjeta
 * del panel se quedaba hasta 5 min y los botones de Telegram seguían vivos aunque ya
 * no hicieran nada. Ahora la pregunta va ligada a la vida del hijo: al caducar, parar
 * o terminar, la tarjeta desaparece (denegada) y Telegram la marca como caducada.
 */
vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logHost: vi.fn(),
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const { ApprovalBroker } = await import('../src/approvals/broker.js');
const { createSpecialistAsk } = await import('../src/daemon/specialist-ask.js');
const { createChildFactory, createDelegateWiring } = await import('../src/core/subagent-wiring.js');
const { resolveSpecialist } = await import('../src/core/specialists.js');
type Gate = import('../src/permissions.js').Gate;
type SpecialistSpec = import('../src/core/specialists.js').SpecialistSpec;

const CONFIG = { maxToolCalls: 20 } as unknown as Config;
const TV = resolveSpecialist('tv') as SpecialistSpec;
const POWER = { tool: 'tv', args: { action: 'power' }, actor: 'subagent' };

function tool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: 'object', properties: { action: { type: 'string' } } },
    execute: async () => ({ content: [{ type: 'text', text: `ok-${name}` }], details: {} }),
  } as unknown as AgentTool;
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('createSpecialistAsk: la pregunta se retira cuando el hijo ya no espera', () => {
  it('panel: al abortar, la tarjeta desaparece y cuenta como denegada', async () => {
    const broker = new ApprovalBroker();
    const ask = createSpecialistAsk({
      panelTurn: () => true,
      viaChannel: async () => true,
      broker,
      chatId: '42',
    });
    const child = new AbortController();
    const answer = ask('Especialista Tele: ¿apago la tele?', child.signal);
    await tick();
    expect(broker.list()).toHaveLength(1);
    child.abort();
    expect(await answer).toBe(false);
    expect(broker.list()).toEqual([]);
  });

  it('panel: con el hijo ya terminado ni se registra', async () => {
    const broker = new ApprovalBroker();
    const ask = createSpecialistAsk({
      panelTurn: () => true,
      viaChannel: async () => true,
      broker,
    });
    const done = new AbortController();
    done.abort();
    expect(await ask('¿?', done.signal)).toBe(false);
    expect(broker.list()).toEqual([]);
  });

  it('Telegram: la señal llega a la pregunta del chat', async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const ask = createSpecialistAsk({
      panelTurn: () => false,
      viaChannel: async (_q, signal) => {
        seen.push(signal);
        return true;
      },
      broker: new ApprovalBroker(),
    });
    const child = new AbortController();
    expect(await ask('¿?', child.signal)).toBe(true);
    expect(seen).toEqual([child.signal]);
  });

  it('una respuesta sin señal sigue igual que antes', async () => {
    const broker = new ApprovalBroker();
    const ask = createSpecialistAsk({
      panelTurn: () => true,
      viaChannel: async () => true,
      broker,
    });
    const answer = ask('¿?');
    await tick();
    const [card] = broker.list();
    broker.resolve(card?.id ?? '', 'once');
    expect(await answer).toBe(true);
  });
});

describe('createChildFactory: el especialista pregunta con la señal del hijo', () => {
  async function gateFor(
    signal: AbortSignal,
    approve: (q: string, s?: AbortSignal) => Promise<boolean>,
  ) {
    let gate: Gate | undefined;
    const make = createChildFactory({
      config: CONFIG,
      createAgent: async (_config, _tools, g) => {
        gate = g;
        return { run: async () => ({ text: '', toolCalls: 0 }), abort: () => {} } as never;
      },
    });
    await make({
      prompt: 'p',
      role: 'explorer',
      tools: ['tv'],
      toolset: [],
      maxToolCalls: 5,
      signal,
      specialist: TV,
      approve,
    });
    return gate as Gate;
  }

  it('pasa la señal del hijo a la pregunta', async () => {
    const child = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const gate = await gateFor(child.signal, async (_q, s) => {
      seen.push(s);
      return true;
    });
    expect((await gate.check('s', POWER)).verdict).toBe('allow');
    expect(seen).toEqual([child.signal]);
  });

  it('con el hijo ya terminado no pregunta y deniega', async () => {
    const child = new AbortController();
    child.abort();
    const approve = vi.fn(async () => true);
    const gate = await gateFor(child.signal, approve);
    expect((await gate.check('s', POWER)).verdict).toBe('deny');
    expect(approve).not.toHaveBeenCalled();
  });
});

describe('delegate: timeout con una pregunta abierta en el panel', () => {
  it('el hijo caduca esperando el «Permitir»: la tarjeta se retira', async () => {
    const broker = new ApprovalBroker();
    const ask = createSpecialistAsk({
      panelTurn: () => true,
      viaChannel: async () => true,
      broker,
    });
    let asked = false;
    const wiring = createDelegateWiring({
      config: CONFIG,
      parentTools: () => [],
      pool: { timeoutMs: 40 },
      createAgent: async (_config, _tools, gate) =>
        ({
          run: async () => {
            asked = true;
            // El hijo se queda esperando la respuesta del panel, que nunca llega.
            await gate.check('s', POWER);
            return { text: 'hecho', toolCalls: 1 };
          },
          abort: () => {},
        }) as never,
    });
    const delegate = wiring.forThread(() => [tool('tv')], ask);
    const res = await delegate.execute('d', { task: 'apaga la tele', specialist: 'tv' } as never);
    expect(asked).toBe(true);
    expect((res.details as { error?: string }).error).toMatch(/Tiempo agotado/);
    await tick();
    expect(broker.list()).toEqual([]);
  });
});
