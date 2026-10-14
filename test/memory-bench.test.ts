// C2 (item 9, PR 9a ronda 2): runner del harness + validación del ground
// truth (auditor: las etiquetas deben ser comprobables). Imprime la tabla;
// los números van en el cuerpo de la PR, no asertos en CI.
// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que paths.ts lo capture
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { corpus, QUERIES, runBench } from '../scripts/memory-bench.js';
import { MemoryStore } from '../src/memory.js';

describe('memory bench: ground truth válido (auditor 9a r2)', () => {
  it('las etiquetas reciente/antiguo/unico cuadran con los índices declarados', () => {
    const n = corpus().length;
    for (const q of QUERIES) {
      for (const i of q.relevantIdx) {
        expect(i, `${q.q}: índice fuera de rango`).toBeLessThan(n);
      }
      if (q.caso === 'unico') expect(q.relevantIdx).toHaveLength(1);
      if (q.targetIdx !== undefined) {
        expect(q.relevantIdx).toContain(q.targetIdx);
        if (q.caso === 'reciente') expect(q.targetIdx).toBe(Math.max(...q.relevantIdx));
        if (q.caso === 'antiguo') expect(q.targetIdx).toBe(Math.min(...q.relevantIdx));
      }
    }
  });

  it('los índices excluidos por supersede son exactamente los corregidos', () => {
    // factura recibo2 = 5, cena día8 = 37, gym semana12 = 56: las queries no
    // los cuentan activos, y el resto de exclusiones no existe.
    const excluded = [5, 37, 56];
    for (const q of QUERIES) {
      for (const i of q.relevantIdx) expect(excluded).not.toContain(i);
    }
  });
});

describe('memory bench (C2, PR 9a)', () => {
  it('mide baseline real vs variantes sobre el corpus declarado', () => {
    expect(FACTORY_TEST_STATE_DIR).toBeTruthy();
    const store = new MemoryStore(mkdtempSync(join(FACTORY_TEST_STATE_DIR, 'bench-')));
    const r = runBench(store);
    console.log(`\n${r.table}\n`);
    expect(r.activeEntries).toBe(60);
    for (const v of [r.hitAnyAt5, r.targetHitAt5, r.targetHitRecientes, r.targetHitAntiguos]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(r.medianMs).toBeGreaterThanOrEqual(0);
    const hoy = r.modes.find((m) => m.name.startsWith('full HOY'));
    const index = r.modes.find((m) => m.name.startsWith('índice propuesto'));
    expect(hoy && index && index.chars < hoy.chars).toBeTruthy();
    // La superada RECIENTE (semana 12 original) aparece en el render real del
    // CLI y no en el índice propuesto: la falsa equivalencia rota a propósito.
    expect(hoy?.name).toContain('INCLUYE superadas');
  });
});
