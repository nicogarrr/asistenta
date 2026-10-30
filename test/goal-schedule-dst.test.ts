import { Cron } from 'croner';
import { describe, expect, it } from 'vitest';
import { findMissedSlot } from '../src/routines.js';

// Los objetivos van como rutinas `objetivo:<id>` sobre croner, en hora local
// (CI: TZ=Europe/Madrid). Estos tests fijan el comportamiento en los dos
// cambios de hora para que una subida de croner o un cambio de opciones no
// haga que un objetivo dispare dos veces o se salte un día sin que nadie lo vea.
const madrid = (d: Date) => d.toLocaleString('es-ES', { timeZone: 'Europe/Madrid', hour12: false });

function next(expr: string, fromIso: string, n: number): string[] {
  const c = new Cron(expr, { mode: '5-or-6-parts', paused: true });
  const out: string[] = [];
  let d: Date | null = new Date(fromIso);
  for (let i = 0; i < n && d; i++) {
    d = c.nextRun(d);
    if (d) out.push(d.toISOString());
  }
  c.stop();
  return out;
}

describe('cadencia de objetivos en el cambio de hora (Europe/Madrid)', () => {
  it('el entorno de test está en hora de Madrid', () => {
    // 2026-07-01 12:00Z son las 14:00 en Madrid (CEST).
    expect(new Date('2026-07-01T12:00:00Z').getHours()).toBe(14);
  });

  it('otoño (25-oct-2026): una cadencia diaria a las 02:30 dispara UNA vez', () => {
    const runs = next('30 2 * * *', '2026-10-24T12:00:00Z', 2);
    expect(runs).toEqual(['2026-10-25T00:30:00.000Z', '2026-10-26T01:30:00.000Z']);
  });

  it('otoño: una cadencia horaria no repite la hora que se repite', () => {
    const runs = next('20 * * * *', '2026-10-24T23:30:00Z', 4);
    // 02:20 CEST y luego 03:20 CET: la 02:20 CET (01:20Z) no se dispara otra vez.
    expect(runs).toEqual([
      '2026-10-25T00:20:00.000Z',
      '2026-10-25T02:20:00.000Z',
      '2026-10-25T03:20:00.000Z',
      '2026-10-25T04:20:00.000Z',
    ]);
    expect(new Set(runs).size).toBe(runs.length);
  });

  it('primavera (29-mar-2026): la 02:30 que no existe se ejecuta a las 03:30, no se pierde el día', () => {
    const runs = next('30 2 * * *', '2026-03-28T12:00:00Z', 2);
    expect(runs[0]).toBe('2026-03-29T01:30:00.000Z');
    expect(madrid(new Date(runs[0] ?? ''))).toContain('3:30:00');
    expect(runs[1]).toBe('2026-03-30T00:30:00.000Z');
  });

  it('recuperación con el PC dormido durante la hora repetida: un solo disparo', () => {
    // Dormido de 01:00 CEST a 04:30 CET del 25-oct; cadencia horaria.
    const missed = findMissedSlot(
      '20 * * * *',
      new Date('2026-10-24T23:00:00Z'),
      new Date('2026-10-25T03:30:00Z'),
    );
    expect(missed?.slot.toISOString()).toBe('2026-10-25T03:20:00.000Z');
  });

  it('recuperación de la 02:30 de primavera perdida con el PC apagado', () => {
    const missed = findMissedSlot(
      '30 2 * * *',
      new Date('2026-03-28T12:00:00Z'),
      new Date('2026-03-29T02:00:00Z'),
    );
    expect(missed?.slot.toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(missed?.withinGrace).toBe(true);
  });
});
