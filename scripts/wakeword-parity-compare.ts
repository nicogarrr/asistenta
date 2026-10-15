/**
 * A1a ronda 2 (auditor #138) — comparación de paridad Node vs Python oficial.
 *
 * Alineación (derivada de utils.py v0.5.1, no asumida):
 *   - El Python oficial siembra feature_buffer con embeddings de ruido y su
 *     melspectrogram_buffer con ones(76,32): sus embeddings de pushes 1..9
 *     están contaminados; la ventana del clasificador (16) es 100% real a
 *     partir del push 25 — el primer push que nuestro runner puntúa.
 *   - Node embedding j (0-based) ↔ push j+10 ↔ Python embeddings[j+9].
 *   - Scores: push p de Node ↔ scores[p-1] de Python, comparados p ≥ 25.
 *
 * Uso: npx tsx scripts/wakeword-parity-compare.ts <node.json> <python.json>
 * Exit 0 si las diferencias entran en tolerancia (redondeo float32 y orden
 * de reducción entre ORT python y ORT node; mismos modelos, mismas entradas).
 */
import { readFileSync } from 'node:fs';

const EMB_ATOL = 1e-3;
const SCORE_ATOL = 1e-4;

const [nodePath, pyPath] = process.argv.slice(2);
if (!nodePath || !pyPath) {
  console.error('uso: npx tsx scripts/wakeword-parity-compare.ts <node.json> <python.json>');
  process.exit(2);
}
const node = JSON.parse(readFileSync(nodePath, 'utf8')) as {
  nPushes: number;
  scores: { push: number; score: number }[];
  embeddings: number[][];
};
const py = JSON.parse(readFileSync(pyPath, 'utf8')) as {
  seedLen: number;
  nPushes: number;
  scores: number[];
  embeddings: number[][];
};

if (node.nPushes !== py.nPushes) {
  console.error(`nPushes difiere: node=${node.nPushes} python=${py.nPushes}`);
  process.exit(1);
}
if (node.embeddings.length !== py.embeddings.length - 9) {
  console.error(
    `embeddings desalineados: node=${node.embeddings.length} python=${py.embeddings.length} (esperado python = node + 9)`,
  );
  process.exit(1);
}

let embMaxAbs = 0;
let embMaxRel = 0;
for (let j = 0; j < node.embeddings.length; j++) {
  const a = node.embeddings[j] ?? [];
  const b = py.embeddings[j + 9] ?? [];
  for (let k = 0; k < a.length; k++) {
    const d = Math.abs((a[k] ?? 0) - (b[k] ?? 0));
    if (d > embMaxAbs) embMaxAbs = d;
    const rel = d / Math.max(1e-6, Math.abs(b[k] ?? 0));
    if (rel > embMaxRel) embMaxRel = rel;
  }
}

let scoreMaxAbs = 0;
let compared = 0;
for (const { push, score } of node.scores) {
  const ref = py.scores[push - 1];
  if (ref === undefined) continue;
  compared++;
  const d = Math.abs(score - ref);
  if (d > scoreMaxAbs) scoreMaxAbs = d;
}

console.log(`seed python: ${py.seedLen} embeddings de ruido (flush en push 25)`);
console.log(`embeddings comparados: ${node.embeddings.length}`);
console.log(`  max abs diff: ${embMaxAbs.toExponential(3)}`);
console.log(`  max rel diff: ${embMaxRel.toExponential(3)}`);
console.log(`scores comparados (push >= 25): ${compared}`);
console.log(`  max abs diff: ${scoreMaxAbs.toExponential(3)}`);

const ok = embMaxAbs <= EMB_ATOL && scoreMaxAbs <= SCORE_ATOL && compared > 0;
console.log(ok ? 'PARIDAD: OK' : 'PARIDAD: FUERA DE TOLERANCIA');
process.exit(ok ? 0 : 1);
