import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CaseResult } from '../src/evolve/battery.js';
import { type BatteryGate, measureBattery } from '../src/evolve/battery-gate.js';
import {
  HISTORY_DIR,
  quarantinedCases,
  recordBaseWeek,
  weekNumber,
} from '../src/evolve/battery-history.js';
import { notCounting } from '../src/evolve/run.js';
import { prunable, stateEntry } from '../src/state-files.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'pa-bhist-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const res = (caseId: string, ok: boolean): CaseResult => ({ caseId, runs: [ok, ok, ok] });
const day = (iso: string) => new Date(`${iso}T12:00:00Z`);
// Lunes de tres semanas ISO seguidas: 2026-W42, W43, W44.
const W42 = day('2026-10-12');
const W43 = day('2026-10-19');
const W44 = day('2026-10-26');
const CASES = [
  { id: 'T01', external: true },
  { id: 'B09', external: undefined },
];

describe('historial por caso de la batería', () => {
  it('aparta un caso externo que falla en la base tres semanas seguidas', () => {
    const d = tmp();
    for (const w of [W42, W43, W44]) recordBaseWeek(d, [res('T01', false), res('B09', false)], w);
    expect([...quarantinedCases(d, CASES, W44)]).toEqual(['T01']);
  });

  it('dos semanas fallando no bastan', () => {
    const d = tmp();
    for (const w of [W43, W44]) recordBaseWeek(d, [res('T01', false)], w);
    expect(quarantinedCases(d, CASES, W44).size).toBe(0);
  });

  it('un caso que no es externo nunca se aparta', () => {
    const d = tmp();
    for (const w of [W42, W43, W44]) recordBaseWeek(d, [res('B09', false)], w);
    expect(quarantinedCases(d, CASES, W44).has('B09')).toBe(false);
  });

  it('un pase en cualquiera de las tres semanas lo mantiene (y un pase en la semana manda)', () => {
    const d = tmp();
    recordBaseWeek(d, [res('T01', false)], W42);
    recordBaseWeek(d, [res('T01', true)], W43);
    recordBaseWeek(d, [res('T01', false)], day('2026-10-21'));
    recordBaseWeek(d, [res('T01', false)], W44);
    expect(quarantinedCases(d, CASES, W44).size).toBe(0);
  });

  it('pasadas 4 semanas desde el último fallo vuelve a probarse', () => {
    const d = tmp();
    for (const w of [W42, W43, W44]) recordBaseWeek(d, [res('T01', false)], w);
    expect(quarantinedCases(d, CASES, day('2026-11-16')).has('T01')).toBe(true);
    expect(quarantinedCases(d, CASES, day('2026-11-23')).has('T01')).toBe(false);
  });

  it('una hoja corrupta o sin carpeta no aparta nada ni rompe', () => {
    const d = tmp();
    writeFileSync(join(d, '2026-W44.json'), '{no es json');
    expect(quarantinedCases(d, CASES, W44).size).toBe(0);
    expect(quarantinedCases(join(d, 'no-existe'), CASES, W44).size).toBe(0);
  });

  it('las semanas cuentan bien al cambiar de año ISO', () => {
    expect(weekNumber('2027-W01') - weekNumber('2026-W53')).toBe(1);
  });

  it('la carpeta está registrada en src/state-files.ts y se poda por semanas', () => {
    expect(stateEntry(HISTORY_DIR)).toBeDefined();
    const p = prunable().find((x) => x.dir === HISTORY_DIR);
    expect(p?.match?.test('2026-W44.json')).toBe(true);
    expect(p?.match?.test('notas.txt')).toBe(false);
  });

  it('un caso apartado no corre ni puntúa, con o sin ciclo', async () => {
    const ran: string[] = [];
    const g: BatteryGate = {
      cases: [
        { id: 'T01', prompt: 'p', machine: { mustMention: ['ok'] }, external: true },
        { id: 'B09', prompt: 'p', machine: { mustMention: ['ok'] } },
      ],
      run: async (c) => {
        ran.push(c.id);
        return { reply: 'ok', toolCalls: [], approvalsAsked: 0 };
      },
      repeats: 1,
      quarantined: new Set(['T01']),
    };
    expect((await measureBattery(g, '/x')).score.total).toBe(1);
    expect((await measureBattery({ ...g, cycle: 0 }, '/x')).score.total).toBe(1);
    expect(ran).toEqual(['B09', 'B09']);
  });

  it('/evolucion dice cuántos casos no cuentan y por qué', () => {
    const state = tmp();
    const file = join(state, 'battery.json');
    writeFileSync(
      file,
      JSON.stringify({
        cases: [
          { id: 'T01', prompt: 'p', machine: { mustMention: ['x'] }, external: true },
          { id: 'B09', prompt: 'p', machine: { mustMention: ['x'] } },
          { id: 'Q1', prompt: 'p', machine: {} },
          { id: 'X1', prompt: 'p', machine: { mustMention: ['x'] }, enabled: false },
        ],
      }),
    );
    const hist = join(state, HISTORY_DIR);
    const now = new Date();
    for (const back of [2, 1, 0])
      recordBaseWeek(hist, [res('T01', false)], new Date(now.getTime() - back * 7 * 86_400_000));
    expect(notCounting(state, file)).toBe(
      'Casos que no cuentan: 3 de 4 (1 desactivados, 1 apartados por webs que fallan 3 semanas, 1 sin criterio de máquina).',
    );
    expect(notCounting(state, join(state, 'no-existe.json'))).toBe(
      'Casos que no cuentan: no se pudo leer la batería.',
    );
  });
});
