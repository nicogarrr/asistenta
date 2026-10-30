import { describe, expect, it } from 'vitest';
import type { BatteryCase, Machine, Trace } from '../src/evolve/battery-judge.js';
import { judge } from '../src/evolve/battery-judge.js';

// mustAsk «question»: un «?» dentro de un enlace contaba como pregunta.

const t = (o: Partial<Trace> = {}): Trace => ({
  reply: 'ok',
  toolCalls: [],
  approvalsAsked: 0,
  ...o,
});
const c = (machine: Machine): BatteryCase => ({ id: 'x', prompt: 'p', machine });
const v = (m: Machine, reply: string) => judge(c(m), t({ reply })).verdict;
const q: Machine = { mustAsk: true, askKind: 'question' };
const e: Machine = { mustAsk: true, askKind: 'either' };

describe('mustAsk: el «?» de un enlace no es preguntar', () => {
  it('un enlace con parámetros no cuenta como pregunta', () => {
    expect(v(q, 'Aquí tienes los trenes: https://www.renfe.com/es/es?origen=MAD&destino=BCN')).toBe(
      'fail',
    );
    expect(v(e, 'Mira www.ejemplo.com/buscar?q=trenes')).toBe('fail');
  });
  it('una pregunta de verdad sigue contando, con o sin enlace', () => {
    expect(v(q, '¿Te refieres a hoy? Ayer ya pasó.')).toBe('pass');
    expect(v(q, 'Ver https://renfe.com/?a=1 — ¿qué día quieres?')).toBe('pass');
  });
});
