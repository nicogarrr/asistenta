import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * /consumo: informe de tokens y coste por dia y por modelo.
 * `paths.ts` congela PA_STATE_DIR al importarse: se prepara antes del import.
 */
const stateDir = mkdtempSync(join(tmpdir(), 'pa-usage-report-'));
const logDir = join(stateDir, 'log');
process.env.PA_STATE_DIR = stateDir;

const usage = await import('../src/core/usage.js');
const fmt = await import('../src/core/usage-format.js');

afterAll(() => {
  delete process.env.PA_STATE_DIR;
  rmSync(stateDir, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(logDir, { recursive: true, force: true });
  mkdirSync(logDir, { recursive: true });
});

function line(day: string, model: string, tokens: number, costMicros: number, extra = ''): string {
  return `${JSON.stringify({
    ts: `${day}T10:00:00.000Z`,
    day,
    sessionId: 's',
    model,
    inputTokens: tokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    kind: 'turn',
    costEur: Math.round(costMicros / 10_000) / 100,
    costMicros,
  })}\n${extra}`;
}

const NOW = new Date(2026, 9, 30, 13, 0); // 30-oct-2026 local

describe('usageReport', () => {
  it('agrega por dia local y por modelo, ignora lineas rotas y dias fuera del periodo', () => {
    writeFileSync(
      join(logDir, 'usage-2026-10-30.jsonl'),
      line('2026-10-30', 'a', 1000, 30_000) + line('2026-10-30', 'b', 500, 5_000, '{roto\n'),
    );
    writeFileSync(
      join(logDir, 'usage-2026-10-25.jsonl'),
      line('2026-10-25', 'a', 12_000, 1_200_000),
    );
    writeFileSync(join(logDir, 'usage-2026-10-20.jsonl'), line('2026-10-20', 'a', 99, 99_000_000));

    const r = usage.usageReport(7, NOW);
    expect(r.days.map((d) => d.day)).toEqual([
      '2026-10-30',
      '2026-10-29',
      '2026-10-28',
      '2026-10-27',
      '2026-10-26',
      '2026-10-25',
      '2026-10-24',
    ]);
    expect(r.today).toMatchObject({ calls: 2, totalTokens: 1500, costMicros: 35_000 });
    expect(r.total).toMatchObject({ calls: 3, totalTokens: 13_500, costMicros: 1_235_000 });
    expect(r.byModel.map((m) => m.model)).toEqual(['a', 'b']);
    expect(r.byModel[0]?.totals.costMicros).toBe(1_230_000);
  });

  it('acota el periodo a 1..31 dias y cruza el cambio de hora de octubre sin saltar dias', () => {
    expect(usage.usageReport(0, NOW).days).toHaveLength(1);
    expect(usage.usageReport(400, NOW).days).toHaveLength(31);
    const days = usage.usageReport(3, new Date(2026, 9, 26, 0, 30)).days.map((d) => d.day);
    expect(days).toEqual(['2026-10-26', '2026-10-25', '2026-10-24']);
  });

  it('sin ficheros devuelve ceros', () => {
    const r = usage.usageReport(7, NOW);
    expect(r.total.calls).toBe(0);
    expect(r.byModel).toEqual([]);
  });
});

describe('formatUsageReport', () => {
  it('muestra hoy, presupuesto, dias con consumo y modelos', () => {
    writeFileSync(
      join(logDir, 'usage-2026-10-30.jsonl'),
      line('2026-10-30', 'big-pickle', 45_200, 120_000),
    );
    writeFileSync(join(logDir, 'usage-2026-10-28.jsonl'), line('2026-10-28', 'gpt', 1234, 3_000));
    const text = fmt.formatUsageReport(usage.usageReport(7, NOW), { budgetEur: 1 });
    expect(text).toContain('Consumo de hoy (30/10): 1 llamada · 45.200 tokens · 0,12 €');
    expect(text).toContain('Presupuesto diario: 0,12 € de 1,00 € (12 %)');
    expect(text).not.toContain('superado');
    expect(text).toContain('Últimos 7 días: 2 llamadas · 46.434 tokens · 0,12 €');
    expect(text).toContain('  28/10  <0,01 € · 1.234 tokens');
    expect(text).not.toContain('29/10');
    expect(text).toContain('  big-pickle: 0,12 € · 45.200 tokens');
  });

  it('marca el presupuesto superado con la misma regla que dailyBudgetExceeded', () => {
    writeFileSync(join(logDir, 'usage-2026-10-30.jsonl'), line('2026-10-30', 'a', 10, 1_500_000));
    const text = fmt.formatUsageReport(usage.usageReport(1, NOW), { budgetEur: 1 });
    expect(text).toContain('1,50 € de 1,00 € (150 %) · superado');
    expect(text).toContain('Por modelo (hoy):');
    expect(text).not.toContain('Últimos');
  });

  it('sin consumo ni presupuesto lo dice claro', () => {
    const text = fmt.formatUsageReport(usage.usageReport(7, NOW));
    expect(text).toContain('Consumo de hoy (30/10): 0 llamadas · 0 tokens · 0,00 €');
    expect(text).toContain('Sin presupuesto diario (PA_DAILY_BUDGET_EUR).');
    expect(text).toContain('Sin consumo registrado en los últimos 7 días.');
  });

  it('agrupa los modelos que no caben', () => {
    let body = '';
    for (const m of ['m1', 'm2', 'm3']) body += line('2026-10-30', m, 100, 10_000);
    writeFileSync(join(logDir, 'usage-2026-10-30.jsonl'), body);
    const text = fmt.formatUsageReport(usage.usageReport(1, NOW), { maxModels: 2 });
    expect(text).toContain('  otros 1: 0,01 € · 100 tokens');
  });
});

describe('formatos y argumentos', () => {
  it('formatea miles y euros sin depender de Intl', () => {
    expect(fmt.formatTokens(1234)).toBe('1.234');
    expect(fmt.formatTokens(1_234_567)).toBe('1.234.567');
    expect(fmt.formatEur(0)).toBe('0,00 €');
    expect(fmt.formatEur(4_000)).toBe('<0,01 €');
    expect(fmt.formatEur(1_234_560_000)).toBe('1.234,56 €');
  });

  it('entiende hoy/semana/mes/N y rechaza lo demás', () => {
    expect(fmt.parseUsageDays('')).toBe(7);
    expect(fmt.parseUsageDays('Hoy')).toBe(1);
    expect(fmt.parseUsageDays('semana')).toBe(7);
    expect(fmt.parseUsageDays('mes')).toBe(30);
    expect(fmt.parseUsageDays('14')).toBe(14);
    expect(fmt.parseUsageDays('0')).toBeNull();
    expect(fmt.parseUsageDays('32')).toBeNull();
    expect(fmt.parseUsageDays('ayer')).toBeNull();
  });
});
