/**
 * Bench brecha 3a: falsos disparos del corte por energía (gate RMS) frente al
 * corte confirmado por Silero VAD (modelo REAL v4.0, sha256 verificado), con
 * fixtures sintéticos deterministas y, si se pasan, habla real en PCM
 * (BARGE_BENCH_SPEECH='/ruta/*.pcm', s16le 16 kHz mono).
 *
 * Simula el camino de producción de conversation.ts nivel 'auriculares'
 * (factor 1, sustain 300 ms, gate 0.05): un CANDIDATO es una racha de >=300 ms
 * por encima del gate; el gate RMS corta siempre; el camino confirmado solo
 * corta si scoreSamples(candidato) >= 0.5. Cuenta eventos por fixture.
 *
 * No es puerta de CI: lo corre a demanda test/barge-bench.test.ts con
 * BARGE_BENCH=1 (descarga el modelo). Las cifras van al body de la PR y a
 * docs/voice-barge-speaker.md.
 */
import { glob, readFile } from 'node:fs/promises';
import { scoreSamples, type VadLike } from '../src/voice/barge-vad.js';
import { SileroVad } from '../src/voice/vad-silero.js';

const SR = 16_000;
const GATE_RMS = 0.05;
const SUSTAIN_MS = 300;
const VAD_PROB = 0.5;
const CHUNK = SR / 10;

const rng = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const rms = (x: Float32Array): number => {
  let s = 0;
  for (const v of x) s += v * v;
  return Math.sqrt(s / x.length);
};

const scaleTo = (x: Float32Array, target: number): Float32Array => {
  const k = target / (rms(x) || 1);
  for (let i = 0; i < x.length; i++) x[i] = (x[i] ?? 0) * k;
  return x;
};

/** Fixtures sintéticos deterministas, 3 s, RMS por encima del gate 0.05. */
export function bargeFixtures(): { name: string; pcm: Float32Array }[] {
  const sec = 3;
  const n = sec * SR;
  const white = new Float32Array(n);
  {
    const rand = rng(11);
    for (let i = 0; i < n; i++) white[i] = (rand() - 0.5) * 2;
  }
  const hum = new Float32Array(n); // aspiradora/ventilador: zumbido + soplido
  {
    const rand = rng(22);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      hum[i] =
        0.5 * Math.sin(2 * Math.PI * 110 * t) +
        0.25 * Math.sin(2 * Math.PI * 220 * t) +
        0.35 * (rand() - 0.5) * 2 * (0.7 + 0.3 * Math.sin(2 * Math.PI * 1.7 * t));
    }
  }
  const clatter = new Float32Array(n); // platos/cubiertos: rachas de impulsos
  {
    const rand = rng(33);
    let env = 0;
    for (let i = 0; i < n; i++) {
      if (rand() < 0.0012) env = 1;
      env *= 0.9992;
      clatter[i] = env * (rand() - 0.5) * 2 * Math.sin(2 * Math.PI * 2800 * (i / SR));
    }
  }
  const music = new Float32Array(n); // acorde sostenido con AM lenta (tele/música)
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const am = 0.7 + 0.3 * Math.sin(2 * Math.PI * 0.9 * t);
    music[i] =
      am *
      (0.5 * Math.sin(2 * Math.PI * 220 * t) +
        0.34 * Math.sin(2 * Math.PI * 277.18 * t) +
        0.28 * Math.sin(2 * Math.PI * 329.63 * t) +
        0.2 * Math.sin(2 * Math.PI * 440 * t));
  }
  const speechLike = new Float32Array(n); // armónicos f0=120 Hz + AM silábica
  {
    const rand = rng(44);
    const syll = 3.4;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      let v = 0;
      for (let k = 1; k <= 12; k++) {
        const f = k * 120;
        v += (Math.exp(-((f - 700) ** 2) / (2 * 600 ** 2)) / k) * Math.sin(2 * Math.PI * f * t);
      }
      speechLike[i] =
        v * (0.55 + 0.45 * Math.max(0, Math.sin(2 * Math.PI * syll * t))) + (rand() - 0.5) * 0.01;
    }
  }
  return [
    { name: 'ruido-blanco', pcm: scaleTo(white, 0.09) },
    { name: 'aspiradora', pcm: scaleTo(hum, 0.09) },
    { name: 'platos', pcm: scaleTo(clatter, 0.08) },
    { name: 'tele-musica', pcm: scaleTo(music, 0.08) },
    { name: 'habla-sintetica', pcm: scaleTo(speechLike, 0.09) },
  ];
}

/** PCM real s16le 16 kHz mono desde fichero. */
async function loadPcm16(file: string): Promise<Float32Array> {
  const buf = await readFile(file);
  const out = new Float32Array(Math.floor(buf.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

interface BenchRow {
  fixture: string;
  seconds: number;
  rmsCuts: number;
  vadCuts: number;
  vadProbMax: number;
}

/**
 * Recorre el fixture en chunks de 100 ms como #feedWhileSpeaking: cada racha
 * de >=300 ms sobre el gate es un candidato (corte RMS). El candidato se
 * puntúa entero con el VAD: >=0.5 es corte confirmado.
 */
async function benchOne(name: string, pcm: Float32Array, vad: VadLike): Promise<BenchRow> {
  let rmsCuts = 0;
  let vadCuts = 0;
  let vadProbMax = 0;
  let run: number[] = [];
  let at = 0;
  const flush = async (): Promise<void> => {
    if (run.length === 0) return;
    if (run.length * CHUNK >= (SUSTAIN_MS * SR) / 1000) {
      rmsCuts++;
      const joined = new Float32Array(run.length * CHUNK);
      for (let c = 0; c < run.length; c++)
        joined.set(pcm.subarray(run[c] ?? 0, (run[c] ?? 0) + CHUNK), c * CHUNK);
      const prob = await scoreSamples(vad, joined);
      if (prob > vadProbMax) vadProbMax = prob;
      if (prob >= VAD_PROB) vadCuts++;
    }
    run = [];
  };
  while (at < pcm.length) {
    const chunk = pcm.subarray(at, at + CHUNK);
    if (rms(chunk) >= GATE_RMS) run.push(at);
    else await flush();
    at += CHUNK;
  }
  await flush();
  return { fixture: name, seconds: pcm.length / SR, rmsCuts, vadCuts, vadProbMax };
}

export async function runBargeBench(modelDir = '.bench-models'): Promise<string> {
  const vad = await SileroVad.create({ modelDir });
  const fixtures = bargeFixtures();
  const speechGlob = process.env.BARGE_BENCH_SPEECH;
  if (speechGlob) {
    for await (const f of glob(speechGlob)) {
      fixtures.push({ name: `habla-real:${f.split('/').pop()}`, pcm: await loadPcm16(f) });
    }
  }
  const rows: BenchRow[] = [];
  for (const f of fixtures) rows.push(await benchOne(f.name, f.pcm, vad));
  const head = '| fixture | segundos | cortes RMS | cortes RMS+VAD | prob VAD máx |';
  const sep = '|---|---|---|---|---|';
  const body = rows.map(
    (r) =>
      `| ${r.fixture} | ${r.seconds.toFixed(1)} | ${r.rmsCuts} | ${r.vadCuts} | ${r.vadProbMax.toFixed(3)} |`,
  );
  const totRms = rows.reduce((a, r) => a + r.rmsCuts, 0);
  const totVad = rows.reduce((a, r) => a + r.vadCuts, 0);
  return [
    'Bench brecha 3a: corte por energía vs corte confirmado por Silero VAD (modelo real v4.0)',
    `gate RMS=${GATE_RMS}, sustain=${SUSTAIN_MS} ms, umbral VAD=${VAD_PROB}`,
    head,
    sep,
    ...body,
    `TOTAL cortes: RMS=${totRms} RMS+VAD=${totVad}`,
  ].join('\n');
}
