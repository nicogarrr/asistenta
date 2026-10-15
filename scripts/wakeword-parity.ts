/**
 * A1a ronda 2 (auditor #138) — arnés de paridad, lado Node.
 *
 * Alimenta un PCM int16 (16kHz mono) por OwwWakeDetector en pushes de 1280
 * muestras y vuelca a JSON: score por push y TODOS los embeddings (96-d),
 * para comparar contra el openwakeword Python OFICIAL v0.5.1
 * (scripts/wakeword-parity.py) sobre el mismo audio.
 *
 * Los embeddings se capturan envolviendo la factory de sesiones (la costura
 * publica del runner): no se toca codigo de produccion para medir.
 *
 * Uso:  npx tsx scripts/wakeword-parity.ts <audio.int16.pcm> <modelsDir> <out.json>
 * Requiere los .onnx reales (ensureOwwModels los descarga si faltan).
 * Opt-in a proposito: no corre en CI (descarga modelos y usa onnxruntime).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  OWW_EMB_SIZE,
  OWW_FIRST_SCORE_FRAME,
  OWW_FRAME_SAMPLES,
  type OwwSessionFactory,
  OwwWakeDetector,
  onnxSessionFactory,
} from '../src/voice/wakeword-oww.js';

const [pcmPath, modelsDir, outPath] = process.argv.slice(2);
if (!pcmPath || !modelsDir || !outPath) {
  console.error('uso: npx tsx scripts/wakeword-parity.ts <int16.pcm> <modelsDir> <out.json>');
  process.exit(2);
}

const buf = readFileSync(pcmPath);
const nSamples = Math.floor(buf.byteLength / 2);
const nPushes = Math.floor(nSamples / OWW_FRAME_SAMPLES);
// int16 -> float [-1,1]: la division es exacta en f64 para todo int16, asi
// que floatToInt16Scale(x) recupera el entero original bit a bit. El lado
// Python recibe el int16 crudo: ambos runners ven EL MISMO melspec input.
const audio = new Float32Array(nPushes * OWW_FRAME_SAMPLES);
for (let i = 0; i < audio.length; i++) audio[i] = buf.readInt16LE(i * 2) / 32767;

const embeddings: number[][] = [];
let pushIndex = 0;
const capturingFactory: OwwSessionFactory = async (modelPath) => {
  const session = await onnxSessionFactory(modelPath);
  if (!modelPath.endsWith('embedding_model.onnx')) return session;
  const innerRun = session.run.bind(session);
  return {
    ...session,
    run: async (feeds) => {
      const out = await innerRun(feeds);
      const vec = out[session.outputNames[0] ?? ''];
      if (!vec || vec.data.length !== OWW_EMB_SIZE) {
        throw new Error('salida de embedding inesperada');
      }
      embeddings.push([...vec.data]);
      return out;
    },
  };
};

const det = await OwwWakeDetector.create({
  modelDir: modelsDir,
  wordModelFile: 'hey_jarvis_v0.1.onnx',
  factory: capturingFactory,
});
const scores: { push: number; score: number }[] = [];
for (let p = 0; p < nPushes; p++) {
  const frame = audio.slice(p * OWW_FRAME_SAMPLES, (p + 1) * OWW_FRAME_SAMPLES);
  const score = await det.pushFrame(frame);
  pushIndex++;
  if (score !== null) scores.push({ push: pushIndex, score });
}
await det.close();

writeFileSync(
  outPath,
  JSON.stringify({ firstScoreFrame: OWW_FIRST_SCORE_FRAME, nPushes, scores, embeddings }),
);
console.log(
  `node: ${nPushes} pushes, ${embeddings.length} embeddings, ${scores.length} scores -> ${outPath}`,
);
