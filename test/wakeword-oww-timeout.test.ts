import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureOwwModels } from '../src/voice/wakeword-oww.js';

/**
 * Una descarga de modelo oww colgada dejaba start() del oyente esperando para
 * siempre (y con él stop(), que comparte el mismo cerrojo). silero_vad ya tenía
 * plazo; oww no pasaba ninguna señal a fetch.
 */
describe('ensureOwwModels: plazo a la descarga', () => {
  it('aborta una descarga que no responde y lo dice en español', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oww-timeout-'));
    let sawSignal = false;
    const hangingFetch = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return; // sin señal: colgado para siempre
        sawSignal = true;
        signal.addEventListener('abort', () => reject(signal.reason));
      })) as unknown as typeof fetch;
    try {
      const outcome = await Promise.race([
        ensureOwwModels(dir, 'w.onnx', hangingFetch, 50).then(
          () => 'resuelto',
          (err: unknown) => (err instanceof Error ? err.message : String(err)),
        ),
        new Promise<string>((r) => setTimeout(() => r('colgado'), 1500)),
      ]);
      expect(sawSignal).toBe(true);
      expect(outcome).toMatch(/sin respuesta/);
      expect(outcome).toMatch(/melspectrogram\.onnx/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
