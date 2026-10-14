// C2 (item 9, PR 9a): runner del harness. Imprime la tabla de medición (los
// números concretos van en el cuerpo de la PR, no asertos en CI) y aserta
// rangos sanos para que el bench no se pudra.
// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que paths.ts lo capture
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runBench } from '../scripts/memory-bench.js';
import { MemoryStore } from '../src/memory.js';

describe('memory bench (C2, PR 9a)', () => {
  it('mide full vs índice vs híbrido sobre el corpus declarado', () => {
    expect(FACTORY_TEST_STATE_DIR).toBeTruthy();
    const store = new MemoryStore(mkdtempSync(join(FACTORY_TEST_STATE_DIR, 'bench-')));
    const r = runBench(store);
    console.log(`\n${r.table}\n`);
    expect(r.activeEntries).toBe(60);
    for (const v of [r.recallAt5, r.recallRecientes, r.recallAntiguos]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(r.medianMs).toBeGreaterThanOrEqual(0);
    const full = r.modes.find((m) => m.name.startsWith('full'));
    const index = r.modes.find((m) => m.name === 'índice (misma ventana 20)');
    // Con entradas largas (el caso real), el índice de la misma ventana recorta.
    expect(full && index && index.chars < full.chars).toBeTruthy();
  });
});
