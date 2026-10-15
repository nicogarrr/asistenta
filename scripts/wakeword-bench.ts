/**
 * Item A1a bench: what always-on wake detection costs with openWakeWord,
 * measured with the REAL ONNX models on real audio, versus the current
 * whisper-pass listener whose cost is documented in src/voice/wake.ts.
 *
 * Manual run on the target machine:
 *   node_modules/ffmpeg-static/ffmpeg -y -i sample.ogg -ar 16000 -ac 1 -f f32le /tmp/sample.pcm
 *   OWW_BENCH_PCM=/tmp/sample.pcm npx vitest run test/wakeword-bench.test.ts
 *
 * The classifier here is hey_jarvis: the point of A1a is pipeline COST, not
 * the word; the Chochi FAR/FRR bench is A1b. Low scores on arbitrary audio
 * are the expected, honest result.
 */
import { readFileSync } from 'node:fs';
import {
  OWW_FIRST_SCORE_FRAME,
  OWW_FRAME_SAMPLES,
  OwwWakeDetector,
} from '../src/voice/wakeword-oww.js';

export async function runWakeBench(pcmPath: string, modelDir: string): Promise<string> {
  const raw = readFileSync(pcmPath);
  const audio = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
  const seconds = audio.length / 16_000;

  const det = await OwwWakeDetector.create({ modelDir, wordModelFile: 'hey_jarvis_v0.1.onnx' });
  let frames = 0;
  let scored = 0;
  let totalMs = 0;
  let maxScore = 0;
  // Simulated real-time pacing: measure CPU per 80ms frame, no sleeping.
  for (let off = 0; off + OWW_FRAME_SAMPLES <= audio.length; off += OWW_FRAME_SAMPLES) {
    const frame = audio.subarray(off, off + OWW_FRAME_SAMPLES);
    const t = performance.now();
    const score = await det.pushFrame(frame);
    totalMs += performance.now() - t;
    frames++;
    if (score !== null) {
      scored++;
      if (score > maxScore) maxScore = score;
    }
  }
  await det.close();

  const msPerFrame = totalMs / frames;
  const cpuPct = (msPerFrame / 80) * 100;
  const lines = [
    '| métrica | valor |',
    '| --- | ---: |',
    `| audio | ${seconds.toFixed(1)}s (${frames} frames de 80ms) |`,
    `| primer score en frame | ${OWW_FIRST_SCORE_FRAME} (~${(OWW_FIRST_SCORE_FRAME * 0.08).toFixed(1)}s) |`,
    `| frames con score | ${scored} |`,
    `| CPU por frame | ${msPerFrame.toFixed(2)}ms |`,
    `| CPU escucha continua | ~${cpuPct.toFixed(1)}% de 1 núcleo |`,
    `| score máximo (palabra ajena, esperado ~0) | ${maxScore.toExponential(2)} |`,
    '| referencia actual: whisper por ventana | 1-2s CPU por pasada cada ≤1.5s (documentado en wake.ts) |',
  ];
  return lines.join('\n');
}
