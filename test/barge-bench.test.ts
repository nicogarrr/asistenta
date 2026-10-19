// Bench brecha 3a (patrón test/wakeword-bench.test.ts): falsos disparos del
// corte por energía vs energía+Silero VAD con el modelo REAL. No es puerta de
// CI: se ejecuta a demanda con BARGE_BENCH=1 (descarga el modelo v4.0) y sus
// cifras se copian a docs/voice-barge-speaker.md y al body de la PR.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const RUN = process.env.BARGE_BENCH === '1';

describe('brecha 3a bench: falsos disparos del barge-in (modelo real)', () => {
  it.runIf(RUN)(
    'el VAD confirma habla y rechaza ruido doméstico sostenido sobre el gate RMS',
    async () => {
      const { runBargeBench } = await import('../scripts/barge-bench.js');
      const table = await runBargeBench(process.env.BARGE_BENCH_MODELS ?? '.bench-models');
      console.log(table);
      expect(table).toContain('cortes RMS');
      // Todo fixture ruidoso pasa el gate RMS: es el falso disparo histórico.
      const noise = /ruido-blanco \| [\d.]+ \| (\d+) \| (\d+) \| ([\d.]+)/.exec(table);
      expect(noise).not.toBeNull();
      expect(Number(noise?.[1])).toBeGreaterThan(0);
      expect(Number(noise?.[2])).toBe(0);
    },
    180_000,
  );
});
