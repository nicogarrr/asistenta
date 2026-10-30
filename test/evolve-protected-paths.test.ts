import { describe, expect, it } from 'vitest';
import { checkPatch } from '../src/evolve/guard.js';
import { touchesForbidden } from '../src/evolve/score.js';

/**
 * Antes había dos listas: la del guard (checkPatch) y la del puntuador (touchesForbidden).
 * Ahora hay una. Toda ruta que cualquiera de las dos rechazaba ayer tiene que seguir
 * rechazada por las dos: unirlas solo puede vetar más.
 */
const REFUSED_TODAY = [
  // lista del guard
  'src/permissions.ts',
  'src/vault.ts',
  'src/selfimprove/x.ts',
  'src/evolve/guard.ts',
  'selfimprove/battery.json',
  'evolve/battery.json',
  'evolve/probe-generic-flow.ts',
  'src/evolve/battery-judge.ts',
  'scripts/evolve-battery-case.mjs',
  'src/browser/ssrf.ts',
  'src/browser/guard.ts',
  'src/tools/approval.ts',
  'src/tools/payment-stage.ts',
  'src/tools/checkout.ts',
  'test/permissions.test.ts',
  'test/approvals-scope.test.ts',
  'test/browser-ssrf.test.ts',
  'test/vault.test.ts',
  'test/checkout.test.ts',
  'test/selfimprove.test.ts',
  'deploy/tv-webos/app.js',
  'package.json',
  'package-lock.json',
  '.github/workflows/ci.yml',
  // lista del puntuador (prefijos, también tras una «/»)
  'src/cli.ts',
  'src/tools/fetch.ts',
  'src/books/net.ts',
  'src/approval-text.ts',
  'src/commerce/cart.ts',
  'src/evolve/loop.ts',
  'src/evolve/score.ts',
  'test/cualquier.test.ts',
  'test/helpers/fake-webos-tv.ts',
  'vitest.config.ts',
  'biome.json',
  'tsconfig.json',
  'tsconfig.build.json',
  'docs/test/notas.md',
  'sub/package.json',
];

const diffOf = (f: string) =>
  `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-a\n+b\n`;

describe('una sola lista de rutas intocables (guard + puntuador)', () => {
  it.each(REFUSED_TODAY)('%s: lo rechazan checkPatch y touchesForbidden', (f) => {
    expect(checkPatch(diffOf(f)).some((v) => v.rule === 'ruta protegida')).toBe(true);
    expect(touchesForbidden([f])).toEqual([f]);
  });

  it('sigue dejando tocar código normal del asistente', () => {
    for (const f of ['src/tools/memory.ts', 'src/agenda/extract.ts', 'docs/evolve-bateria.md']) {
      expect(checkPatch(diffOf(f))).toEqual([]);
      expect(touchesForbidden([f])).toEqual([]);
    }
  });
});
