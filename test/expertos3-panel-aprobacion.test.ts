import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

/**
 * Especialistas con efectos pedidos desde el panel web (asis-expertos-3, PR 1). En
 * Telegram nada cambia; en un turno del panel la pregunta sale en la tarjeta
 * «Aprobaciones» del panel (broker), solo admite «una vez» o «denegar», caduca en
 * deny y /stop la deniega. Nunca se ejecuta nada sin un sí a esa acción.
 */
vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logHost: vi.fn(),
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const { ApprovalBroker } = await import('../src/approvals/broker.js');
const { createSpecialistAsk, denySpecialistAsksForChat, SPECIALIST_PANEL_REASON } = await import(
  '../src/daemon/specialist-ask.js'
);
const { resolveSpecialist } = await import('../src/core/specialists.js');
const { createEffectfulChildGate } = await import('../src/core/subagent-wiring.js');
type SpecialistSpec = import('../src/core/specialists.js').SpecialistSpec;

const TV = resolveSpecialist('tv') as SpecialistSpec;
const POWER = { tool: 'tv', args: { action: 'power' }, actor: 'subagent' } as const;

/** Espera a que aparezca una aprobación pendiente en el broker. */
async function pendingOf(broker: InstanceType<typeof ApprovalBroker>) {
  for (let i = 0; i < 50; i++) {
    const list = broker.list();
    if (list.length > 0) return list;
    await new Promise((r) => setTimeout(r, 5));
  }
  return broker.list();
}

describe('especialista con efectos desde el panel', () => {
  it('en Telegram pregunta por el canal como siempre y el broker no se toca', async () => {
    const broker = new ApprovalBroker();
    const asked: string[] = [];
    const ask = createSpecialistAsk({
      panelTurn: () => false,
      viaChannel: async (q) => {
        asked.push(q);
        return true;
      },
      broker,
      chatId: '1',
    });
    const gate = createEffectfulChildGate({}, TV, ask);
    expect((await gate.check('s', { ...POWER })).verdict).toBe('allow');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^Especialista Tele: /);
    expect(broker.size).toBe(0);
  });

  it('en el panel la pregunta sale en Aprobaciones (no en Telegram) y «una vez» la permite', async () => {
    const broker = new ApprovalBroker();
    const viaChannel = vi.fn(async () => true);
    const ask = createSpecialistAsk({ panelTurn: () => true, viaChannel, broker, chatId: '1' });
    const gate = createEffectfulChildGate({}, TV, ask);
    const verdict = gate.check('s', { ...POWER });
    const [pending] = await pendingOf(broker);
    expect(pending).toBeDefined();
    expect(pending?.question).toMatch(/^Especialista Tele: /);
    expect(pending?.onceOnly).toBe(true);
    expect(pending?.reason).toBe(SPECIALIST_PANEL_REASON);
    expect(pending?.chatId).toBe('1');
    expect(viaChannel).not.toHaveBeenCalled();
    expect(broker.resolve(pending?.id ?? '', 'once')).toBe(true);
    expect((await verdict).verdict).toBe('allow');
    expect(broker.size).toBe(0);
  });

  it('«Por ahora» y «Siempre» no valen: sigue pendiente y no deja nada para la siguiente', async () => {
    const broker = new ApprovalBroker();
    const ask = createSpecialistAsk({
      panelTurn: () => true,
      viaChannel: async () => true,
      broker,
    });
    const gate = createEffectfulChildGate({}, TV, ask);
    const first = gate.check('s', { ...POWER });
    const [pending] = await pendingOf(broker);
    const id = pending?.id ?? '';
    expect(broker.resolve(id, 'always')).toBe(false);
    expect(broker.resolve(id, 'session')).toBe(false);
    expect(broker.get(id)).toBeDefined();
    expect(broker.resolve(id, 'once')).toBe(true);
    expect((await first).verdict).toBe('allow');
    // La misma acción otra vez vuelve a preguntar: nada heredado.
    const second = gate.check('s', { ...POWER });
    const [again] = await pendingOf(broker);
    expect(again?.id).toBeDefined();
    expect(again?.id).not.toBe(id);
    expect(broker.resolve(again?.id ?? '', 'deny')).toBe(true);
    expect((await second).verdict).toBe('deny');
  });

  it('sin respuesta a tiempo se deniega y la tarjeta desaparece', async () => {
    const broker = new ApprovalBroker();
    const ask = createSpecialistAsk({
      panelTurn: () => true,
      viaChannel: async () => true,
      broker,
      ttlMs: 20,
    });
    const gate = createEffectfulChildGate({}, TV, ask);
    expect((await gate.check('s', { ...POWER })).verdict).toBe('deny');
    expect(broker.size).toBe(0);
  });

  it('si no se puede registrar la pregunta, se deniega (nunca se ejecuta sin preguntar)', async () => {
    const broken = {
      register: () => {
        throw new Error('broker roto');
      },
      wait: async () => 'once' as const,
    };
    const viaChannel = vi.fn(async () => true);
    const ask = createSpecialistAsk({ panelTurn: () => true, viaChannel, broker: broken });
    expect(await ask('Especialista Tele: ¿apago?')).toBe(false);
    expect(viaChannel).not.toHaveBeenCalled();
  });

  it('/stop deniega solo las preguntas de especialista de ese chat', async () => {
    const broker = new ApprovalBroker();
    const otherDecision: string[] = [];
    const other = broker.register({
      tool: 'shell',
      reason: 'x',
      question: 'otra',
      chatId: '1',
      resolve: (d) => otherDecision.push(d),
    });
    const ask1 = createSpecialistAsk({
      panelTurn: () => true,
      viaChannel: async () => true,
      broker,
      chatId: '1',
    });
    const ask2 = createSpecialistAsk({
      panelTurn: () => true,
      viaChannel: async () => true,
      broker,
      chatId: '2',
    });
    const a = ask1('Especialista Tele: ¿apago?');
    const b = ask2('Especialista Casa: ¿enciendo?');
    while (broker.size < 3) await new Promise((r) => setTimeout(r, 5));
    expect(denySpecialistAsksForChat(broker, '1')).toBe(1);
    expect(await a).toBe(false);
    expect(broker.get(other.id)).toBeDefined();
    expect(otherDecision).toEqual([]);
    expect(denySpecialistAsksForChat(broker)).toBe(1);
    expect(await b).toBe(false);
  });
});

describe('cableado real', () => {
  it('cli.ts pasa la pregunta del especialista por createSpecialistAsk y /stop la deniega', () => {
    const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(source).toContain('createSpecialistAsk({');
    expect(source).toContain('panelTurn: () => threadOutputs.get(thread.key) !== undefined');
    expect(source).toContain('viaChannel: (question) => askOncePerTurn(thread, question)');
    expect(source).toContain('denySpecialistAsksForChat(approvals, inbound.chatId)');
    expect(source).toContain('denySpecialistAsksForChat(approvals);');
  });

  it('el panel solo enseña «una vez» y «denegar» en las preguntas onceOnly', () => {
    const source = readFileSync(new URL('../src/webui/page.ts', import.meta.url), 'utf8');
    expect(source).toContain('item.onceOnly === true');
    expect(source).toMatch(
      /soloUnaVez && DECISIONES\[j\]\.id !== 'once' && DECISIONES\[j\]\.id !== 'deny'/,
    );
  });
});
