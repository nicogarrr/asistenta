import { describe, expect, it } from 'vitest';
import { PlanPrecios } from '../src/precios/planificador.js';

const MIN = 60_000;

function plan(silencio: (now: number) => boolean) {
  let now = 0;
  const hechos: boolean[] = [];
  const p = new PlanPrecios({
    barrer: async (rapido) => void hechos.push(rapido),
    cadaMin: 30,
    rapidoMin: 12,
    silencio,
    now: () => now,
    azar: () => 0.5,
  });
  return {
    p,
    hechos,
    ir: (ms: number) => {
      now = ms;
    },
  };
}

describe('precios: barridos también de noche', () => {
  it('en horas de silencio sigue barriendo, más despacio', async () => {
    const { p, hechos, ir } = plan(() => true);
    ir(2 * MIN);
    expect(await p.tick()).toBe('normal');
    expect(hechos).toEqual([false]);
    // De noche, el normal va cada 60 min en vez de 30.
    expect(p.proximo('normal')).toBe(2 * MIN + 60 * MIN);
    ir(25 * MIN);
    expect(await p.tick()).toBe('rapido');
    expect(p.proximo('rapido')).toBe(25 * MIN + 24 * MIN);
  });

  it('de día, al ritmo normal', async () => {
    const { p, ir } = plan(() => false);
    ir(2 * MIN);
    await p.tick();
    expect(p.proximo('normal')).toBe(32 * MIN);
  });

  it('un barrido atrasado (p. ej. tras horas sin reloj) sale en el siguiente tick', async () => {
    const { p, hechos, ir } = plan(() => false);
    ir(5 * 60 * MIN);
    expect(await p.tick()).toBe('normal');
    expect(await p.tick()).toBe('rapido');
    expect(hechos).toEqual([false, true]);
  });
});
