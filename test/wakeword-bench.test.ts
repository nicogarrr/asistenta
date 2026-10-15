// Item A1a bench (patron de test/memory-bench.test.ts): imprime la tabla de
// coste del runner oww con modelos REALES. Se salta si falta la muestra de
// audio (maquina sin ella) - el bench es una prueba de coste ejecutada a
// demanda, no una puerta del CI.
import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const SAMPLE = process.env.OWW_BENCH_PCM ?? '/tmp/oww-spike/nico1.pcm';
const HAS_SAMPLE = existsSync(SAMPLE);

describe('A1a bench: coste CPU del runner openWakeWord (modelos reales)', () => {
  it.runIf(HAS_SAMPLE)(
    'mide CPU/frame sobre la muestra y el score se mantiene bajo con palabra ajena',
    async () => {
      const { runWakeBench } = await import('../scripts/wakeword-bench.js');
      const table = await runWakeBench(SAMPLE, process.env.OWW_BENCH_MODELS ?? '.bench-models');
      console.log(table);
      expect(table).toContain('CPU por frame');
      expect(table).toContain('frames de 80ms');
      // Palabra ajena (hey_jarvis sobre "Chochi"): ningun falso disparo.
      const max = /score máximo \(palabra ajena, esperado ~0\) \| ([\d.e+-]+)/.exec(table);
      expect(max).not.toBeNull();
      expect(Number(max?.[1])).toBeLessThan(0.5);
    },
    120_000,
  );
});
