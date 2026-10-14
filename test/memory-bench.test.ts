// C2 (item 9, PR 9a ronda 3): runner + validación del ground truth derivado
// (auditor). Imprime la tabla; los números van en la PR, no asertos en CI.
// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que paths.ts lo capture
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CORRECTIONS,
  groundTruth,
  renderBaselineHoy,
  renderIndex,
  runBench,
  seedBench,
} from '../scripts/memory-bench.js';
import { MemoryStore } from '../src/memory.js';

function seededStore() {
  const store = new MemoryStore(mkdtempSync(join(FACTORY_TEST_STATE_DIR, 'bench-')));
  seedBench(store, 'bench:corpus#main');
  return store;
}

describe('memory bench: ground truth derivado y válido (auditor 9a r3)', () => {
  it('el conjunto relevante por tema es EXACTAMENTE el de activas del store', () => {
    const store = seededStore();
    const all = store.all('bench:corpus#main');
    const gt = groundTruth(all);
    const correctedTexts = CORRECTIONS.map((c) => c.text);
    for (const t of ['facturas', 'gym', 'familia', 'trabajo', 'banco']) {
      const expected = all.filter((e) => e.supersededBy === null && e.tags.includes(t)).length;
      expect(expected, `tema ${t}`).toBe(12); // 12 seeds -1 superada +1 replacement (los temas corregidos)
    }
    for (const g of gt) {
      expect(g.relevantIds.length, `${g.q}: sin relevantes`).toBeGreaterThan(0);
      if (g.caso === 'unico') expect(g.relevantIds).toHaveLength(1);
      expect(g.targetId).not.toBeNull();
      expect(g.relevantIds).toContain(g.targetId);
    }
    // Los replacements están en el ground truth (corrección gym 53kg incluida).
    const gymQ = gt.find((g) => g.q === 'cuánto levanto en press banca');
    const gymTexts = all.filter((e) => gymQ?.relevantIds.includes(e.id)).map((e) => e.text);
    expect(gymTexts.some((t) => correctedTexts.some((c) => t === c))).toBe(true);
    // Y los originales corregidos NO están: igualdad de conjuntos por tema.
    expect(gymTexts.some((t) => t.includes('Entrenamiento semana 12: press banca 52 kg'))).toBe(
      false,
    );
  });

  it('reciente = última posición del conjunto; antiguo = primera', () => {
    const store = seededStore();
    const all = store.all('bench:corpus#main');
    const pos = new Map(all.map((e, i) => [e.id, i]));
    for (const g of groundTruth(all)) {
      if (g.caso === 'unico') continue;
      const positions = g.relevantIds.map((id) => pos.get(id) ?? -1);
      if (g.caso === 'reciente') expect(pos.get(g.targetId ?? '')).toBe(Math.max(...positions));
      if (g.caso === 'antiguo') expect(pos.get(g.targetId ?? '')).toBe(Math.min(...positions));
    }
  });
});

describe('memory bench (C2, PR 9a)', () => {
  it('mide baseline real vs variantes; el contenido distingue superadas', () => {
    expect(FACTORY_TEST_STATE_DIR).toBeTruthy();
    // runBench siembra él mismo: una sola siembra por store.
    const store = new MemoryStore(mkdtempSync(join(FACTORY_TEST_STATE_DIR, 'bench-')));
    expect(store.all('bench:corpus#main')).toHaveLength(0);
    const r = runBench(store);
    console.log(`\n${r.table}\n`);

    // Contenido, no nombre (auditor): el baseline del CLI incluye la superada
    // reciente original; la variante índice no.
    const all = store.all('bench:corpus#main');
    const activas = all.filter((e) => e.supersededBy === null);
    const hoy = renderBaselineHoy(all);
    expect(hoy).toContain('Entrenamiento semana 12: press banca 52 kg');
    expect(renderIndex(activas.slice(-20))).not.toContain(
      'Entrenamiento semana 12: press banca 52 kg',
    );
    expect(renderIndex(activas.slice(-20)).split('\n')).toHaveLength(20);

    expect(r.activeEntries).toBe(60);
    for (const v of [r.hitAnyAt5, r.targetHitAt5, r.targetHitRecientes, r.targetHitAntiguos]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(r.medianMs).toBeGreaterThanOrEqual(0);
    const hoyMode = r.modes.find((m) => m.name.startsWith('full HOY'));
    const indexMode = r.modes.find((m) => m.name.startsWith('índice propuesto'));
    expect(hoyMode && indexMode && indexMode.chars < hoyMode.chars).toBeTruthy();
    expect(indexMode?.entries).toBe(20);
  });
});
