import { describe, expect, it } from 'vitest';
// Script Node ESM puro de CI, fuera del build de producción.
// @ts-expect-error TS7016: módulo .mjs ejecutable, sin declaración de tipos.
import { coverageMarkdown } from '../scripts/coverage-summary.mjs';

describe('resumen de cobertura para CI', () => {
  it('pinta una tabla con las cuatro métricas del total', () => {
    const md: string = coverageMarkdown({
      total: {
        lines: { pct: 71.234, covered: 712, total: 1000 },
        statements: { pct: 70, covered: 700, total: 1000 },
        functions: { pct: 65.5, covered: 131, total: 200 },
        branches: { pct: 60, covered: 300, total: 500 },
      },
    });
    expect(md).toContain('| Líneas | 71.23 % | 712 / 1000 |');
    expect(md).toContain('| Funciones | 65.50 % | 131 / 200 |');
    expect(md).toContain('| Ramas | 60.00 % | 300 / 500 |');
  });

  it('sin datos no revienta: lo dice', () => {
    expect(coverageMarkdown({})).toContain('Sin datos de cobertura');
    expect(coverageMarkdown(undefined)).toContain('Sin datos de cobertura');
  });
});
