import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cycleOfWeek, heavyRotation, selectCases } from '../src/evolve/battery-gate.js';
import { describeLast, heavyThisWeek } from '../src/evolve/run.js';

// /evolucion dice qué casos pesados rotan esta semana: la misma selección que corre el ciclo.

const caso = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: id,
  prompt: `prueba ${id}`,
  session: null,
  severity: 'S2',
  machine: { mustMention: ['x'] },
  ...extra,
});

const BATTERY = {
  version: 1,
  cases: [
    caso('C1'),
    caso('H0', { cost: 'heavy', rotation: 0 }),
    caso('H1', { cost: 'heavy', rotation: 1 }),
    caso('H2', { cost: 'heavy', rotation: 2 }),
    caso('H2b', { cost: 'heavy', rotation: 2 }),
    caso('HA', { cost: 'heavy', rotation: 'always' }),
  ],
};

describe('rotación de los casos pesados', () => {
  it('la semana ISO da el ciclo, y el turno son los heavy de ese tercio (sin los always)', () => {
    expect(cycleOfWeek('2026-W44')).toBe(44);
    expect(cycleOfWeek('raro')).toBe(0);
    expect(heavyRotation(BATTERY as never, 44)).toEqual({ turn: 3, ids: ['H2', 'H2b'] });
    expect(heavyRotation(BATTERY as never, 45)).toEqual({ turn: 1, ids: ['H0'] });
    const ran = selectCases(BATTERY as never, 44).map((c) => c.id);
    for (const id of heavyRotation(BATTERY as never, 44).ids) expect(ran).toContain(id);
  });

  it('/evolucion lo cuenta en una línea', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-rot-'));
    const file = join(dir, 'battery.json');
    writeFileSync(file, JSON.stringify(BATTERY));
    expect(heavyThisWeek(join(dir, 'state'), file, '2026-W46')).toBe(
      'Casos pesados que rotan esta semana (turno 2 de 3): H1.',
    );
    expect(heavyThisWeek(join(dir, 'state'), join(dir, 'no.json'), '2026-W46')).toMatch(
      /no se pudo leer/,
    );
    expect(describeLast(join(dir, 'state'))).toMatch(
      /Casos pesados que rotan esta semana \(turno [123] de 3\)/,
    );
  });
});
