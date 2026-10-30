import { describe, expect, it } from 'vitest';
import { parseSuite } from '../src/evolve/measure.js';

describe('evolve/measure parseSuite', () => {
  it('lee la línea Tests de siempre', () => {
    const out = ' Test Files  1 failed | 3 passed (4)\n      Tests  2 failed | 30 passed (32)\n';
    expect(parseSuite(out)).toEqual({ passed: 30, failed: 2 });
  });

  it('un fichero de test que no carga cuenta como fallo aunque Tests esté en verde', () => {
    const out = [
      ' FAIL  test/roto.test.ts [ test/roto.test.ts ]',
      "SyntaxError: Unexpected token ')'",
      ' Test Files  1 failed | 3 passed (4)',
      '      Tests  30 passed (30)',
    ].join('\n');
    expect(parseSuite(out)).toEqual({ passed: 30, failed: 1 });
  });

  it('un error no capturado (línea Errors) cuenta como fallo', () => {
    const out = [
      ' Test Files  4 passed (4)',
      '      Tests  30 passed (30)',
      '     Errors  1 error',
    ].join('\n');
    expect(parseSuite(out)).toEqual({ passed: 30, failed: 1 });
  });

  it('con colores ANSI también', () => {
    const out =
      '\u001b[2m Test Files \u001b[22m \u001b[1m\u001b[31m2 failed\u001b[39m\u001b[22m\n\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[32m5 passed\u001b[39m\u001b[22m\n';
    expect(parseSuite(out)).toEqual({ passed: 5, failed: 2 });
  });

  it('sin resumen: cero y cero', () => {
    expect(parseSuite('nada útil')).toEqual({ passed: 0, failed: 0 });
  });
});
