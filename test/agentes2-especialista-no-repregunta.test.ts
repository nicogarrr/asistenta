import { describe, expect, it } from 'vitest';
import { resolveSpecialist, type SpecialistSpec } from '../src/core/specialists.js';
import { createEffectfulChildGate } from '../src/core/subagent-wiring.js';

/**
 * Probado con DeepSeek v4.1 de verdad (agentes-e2e-2, 2 nov 2026): «Encárgale a tu
 * especialista de la tele que la apague», Nico dice que no y el especialista
 * vuelve a pedir lo mismo dos veces más en la misma delegación: tres preguntas
 * seguidas en Telegram para una sola orden, aunque su prompt dice «si dice que no,
 * para». Ahora, tras un «no», la misma pregunta de ese especialista en esa
 * delegación se deniega sin volver a preguntar. Solo deniega antes: nunca aprueba
 * nada solo, y una acción distinta sigue preguntando.
 */
const tv = resolveSpecialist('tv') as SpecialistSpec;
const apagar = { tool: 'tv', args: { action: 'power', state: 'off' }, actor: 'subagent' };

describe('especialista: tras un «no», no vuelve a preguntar lo mismo', () => {
  it('la misma acción denegada no se pregunta otra vez en la misma delegación', async () => {
    const asked: string[] = [];
    const gate = createEffectfulChildGate({}, tv, async (q) => {
      asked.push(q);
      return false;
    });
    expect((await gate.check('s1', apagar)).verdict).toBe('deny');
    expect((await gate.check('s1', apagar)).verdict).toBe('deny');
    expect((await gate.check('s1', apagar)).verdict).toBe('deny');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^Especialista Tele: /);
  });

  it('una acción distinta sí se pregunta', async () => {
    const asked: string[] = [];
    const gate = createEffectfulChildGate({}, tv, async (q) => {
      asked.push(q);
      return false;
    });
    await gate.check('s1', apagar);
    await gate.check('s1', {
      tool: 'tv',
      args: { action: 'volume', level: 10 },
      actor: 'subagent',
    });
    expect(asked).toHaveLength(2);
  });

  it('un «sí» se sigue preguntando cada vez (no se recuerda como permiso)', async () => {
    const asked: string[] = [];
    const gate = createEffectfulChildGate({}, tv, async (q) => {
      asked.push(q);
      return true;
    });
    expect((await gate.check('s1', apagar)).verdict).toBe('allow');
    expect((await gate.check('s1', apagar)).verdict).toBe('allow');
    expect(asked).toHaveLength(2);
  });

  it('si preguntar falla, se deniega y la siguiente vez se vuelve a intentar preguntar', async () => {
    let calls = 0;
    const gate = createEffectfulChildGate({}, tv, async () => {
      calls++;
      if (calls === 1) throw new Error('Telegram caído');
      return false;
    });
    expect((await gate.check('s1', apagar)).verdict).toBe('deny');
    expect((await gate.check('s1', apagar)).verdict).toBe('deny');
    expect(calls).toBe(2);
  });

  it('cada delegación nueva vuelve a preguntar (gate nueva)', async () => {
    const asked: string[] = [];
    const approve = async (q: string) => {
      asked.push(q);
      return false;
    };
    await createEffectfulChildGate({}, tv, approve).check('s1', apagar);
    await createEffectfulChildGate({}, tv, approve).check('s2', apagar);
    expect(asked).toHaveLength(2);
  });
});
