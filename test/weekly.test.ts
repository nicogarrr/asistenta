import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { ActionEntry } from '../src/audit/log.js';
import { buildWeeklySummary, isWeeklyDue, WeeklyState } from '../src/weekly.js';

const NOW = Date.parse('2026-10-04T16:00:00Z');
const e = (daysAgo: number, action: string, result: ActionEntry['result'] = 'ok'): ActionEntry => ({
  ts: new Date(NOW - daysAgo * 86_400_000).toISOString(),
  actor: 'asistenta',
  action,
  result,
});

describe('buildWeeklySummary', () => {
  it('counts only the last 7 days and reports failures honestly', () => {
    const text = buildWeeklySummary({
      entries: [e(1, 'turn'), e(2, 'turn', 'error'), e(3, 'vigila_cambio'), e(9, 'turn')],
      now: NOW,
      pending: 'Pendientes: llamar a Juan',
      watching: 2,
    });
    expect(text).toContain('Peticiones atendidas: 2 (1 fallaron)');
    expect(text).toContain('Cambios detectados en páginas vigiladas: 1');
    expect(text).toContain('vigilo ahora: 2');
    expect(text).toContain('llamar a Juan');
  });
  it('says plainly when nothing happened', () => {
    const text = buildWeeklySummary({
      entries: [e(20, 'turn')],
      now: NOW,
      pending: '',
      watching: 0,
    });
    expect(text).toContain('No hemos hablado ni he detectado cambios');
  });
});

describe('descargas en el resumen', () => {
  it('cuenta enviadas y fallidas', () => {
    const text = buildWeeklySummary({
      entries: [e(1, 'descarga'), e(1, 'descarga'), e(2, 'descarga', 'error'), e(10, 'descarga')],
      now: NOW,
      pending: '',
      watching: 0,
    });
    expect(text).toContain('Descargas: 2 enviadas, 1 fallaron');
  });
  it('una semana solo con descargas no se dice vacía', () => {
    const text = buildWeeklySummary({
      entries: [e(1, 'descarga')],
      now: NOW,
      pending: '',
      watching: 0,
    });
    expect(text).not.toContain('No hemos hablado');
  });
});

describe('isWeeklyDue / WeeklyState', () => {
  it('is due Sunday from 18:00 local, once per week', () => {
    const sun18 = new Date(2026, 9, 4, 18, 5); // domingo 4 oct 2026
    expect(sun18.getDay()).toBe(0);
    expect(isWeeklyDue(sun18, 0)).toBe(true);
    expect(isWeeklyDue(new Date(2026, 9, 4, 17, 59), 0)).toBe(false);
    expect(isWeeklyDue(new Date(2026, 9, 5, 19, 0), 0)).toBe(false);
    expect(isWeeklyDue(sun18, sun18.getTime() - 3_600_000)).toBe(false);
    expect(isWeeklyDue(sun18, sun18.getTime() - 7 * 86_400_000)).toBe(true);
  });
  it('persists the last send', () => {
    const s = new WeeklyState(new DatabaseSync(':memory:'));
    expect(s.lastSent('1')).toBe(0);
    s.markSent('1', 5);
    s.markSent('1', 9);
    expect(s.lastSent('1')).toBe(9);
  });
});
