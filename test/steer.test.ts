import { describe, expect, it } from 'vitest';
import { type SteerableThread, steerChat } from '../src/steer.js';

function thread(chatKey: string, active: boolean, got: string[]): SteerableThread {
  return { chatKey, active, agent: { steer: (t) => got.push(t) } };
}

describe('/steer', () => {
  it('manda la instrucción solo a las conversaciones activas de ese chat', () => {
    const got: string[] = [];
    const threads = [
      thread('tg:1', true, got),
      thread('tg:1', false, got),
      thread('tg:2', true, got),
    ];
    expect(steerChat(threads, 'tg:1', '  usa   Booking  en vez de Kayak ')).toEqual({ sent: 1 });
    expect(got).toEqual(['usa Booking en vez de Kayak']);
  });

  it('sin nada en curso devuelve 0 y no guarda la instrucción para luego', () => {
    const got: string[] = [];
    expect(steerChat([thread('tg:1', false, got)], 'tg:1', 'hazlo más corto')).toEqual({ sent: 0 });
    expect(got).toEqual([]);
  });

  it('rechaza una instrucción vacía y recorta las larguísimas', () => {
    const got: string[] = [];
    const t = [thread('tg:1', true, got)];
    expect(steerChat(t, 'tg:1', '   ').error).toMatch(/Dime qué cambiar/);
    steerChat(t, 'tg:1', 'x'.repeat(5000));
    expect(got[0]?.length).toBe(2000);
  });
});
