/**
 * Verificación de hablante local (brecha 3b): enrolamiento y verificación de
 * las voces del hogar, para que SOLO las voces enroladas puedan mandar en una
 * conversación por voz (la tercera voz no enrolada no debe poder).
 *
 * Extractor por defecto: embedding de energías log-mel (40 bandas, 25 ms/10 ms
 * a 16 kHz) promediadas por media y desviación a lo largo del enunciado (80
 * coeficientes, normalizado L2), comparado por coseno. Es una base ligera sin
 * red neuronal: suficiente para separar voces de timbre claramente distinto y
 * ruido, NO es un ECAPA-TDNN. La interfaz `SpeakerExtractor` queda lista para
 * enchufar un modelo ONNX de embeddings (spkrec-ecapa-voxceleb) cuando se
 * valide en el PC de Nico con voces reales; el cambio de extractor no toca el
 * almacén de perfiles ni la puerta de la conversación.
 *
 * Umbrales: `threshold` (coseno mínimo) y `margin` (ventaja sobre el segundo
 * perfil) son conservadores y AJUSTABLES con PA_SPEAKER_THRESHOLD /
 * PA_SPEAKER_MARGIN. Pendiente medir con las voces reales del hogar (las
 * muestras de la segunda persona aún no existen): el bench sintético valida
 * la mecánica, no la frontera entre dos voces humanas.
 *
 * Privacidad: los perfiles son vectores de 80 números (no audio) en
 * STATE_DIR/voice/speaker-profiles.json; no se puede reconstruir la voz.
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { log } from '../log.js';

export const SPK_SAMPLE_RATE = 16_000;
export const SPK_FRAME = 400; // 25 ms
export const SPK_HOP = 160; // 10 ms
export const SPK_NFFT = 512;
export const SPK_MEL_BANDS = 40;
/** Coseno mínimo para aceptar; ~0.62 separa timbres distintos en el banco sintético. */
export const SPK_DEFAULT_THRESHOLD = 0.62;
/** Ventaja mínima sobre el segundo perfil enrolado (con uno solo no aplica). */
export const SPK_DEFAULT_MARGIN = 0.04;
/** Menos audio con voz que esto no da un embedding fiable. */
export const SPK_MIN_SECONDS = 0.8;

export interface SpeakerExtractor {
  /** Embedding normalizado L2 de un enunciado (16 kHz mono). */
  extract(samples: Float32Array): Promise<Float32Array> | Float32Array;
}

export interface SpeakerProfileInfo {
  name: string;
  utterances: number;
  enrolledAt: string;
}

export interface VerifyResult {
  accepted: boolean;
  /** Mejor perfil aunque se rechace (null sin perfiles). */
  speaker: string | null;
  /** Coseno con el mejor perfil; NaN sin perfiles. */
  score: number;
  /** Coseno con el segundo mejor; NaN con un solo perfil. */
  second: number;
}

interface StoredProfile {
  name: string;
  enrolledAt: string;
  utterances: number;
  embedding: number[];
}

interface StoredFile {
  version: 1;
  profiles: StoredProfile[];
}

/** FFT radix-2 in-place (re/im de longitud potencia de dos). */
function fftRadix2(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i] ?? 0;
      re[i] = re[j] ?? 0;
      re[j] = tr;
      const ti = im[i] ?? 0;
      im[i] = im[j] ?? 0;
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wre = Math.cos(ang);
    const wim = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curre = 1;
      let curim = 0;
      for (let j = 0; j < len / 2; j++) {
        const ure = re[i + j] ?? 0;
        const uim = im[i + j] ?? 0;
        const xre = re[i + j + len / 2] ?? 0;
        const xim = im[i + j + len / 2] ?? 0;
        const vre = xre * curre - xim * curim;
        const vim = xre * curim + xim * curre;
        re[i + j] = ure + vre;
        im[i + j] = uim + vim;
        re[i + j + len / 2] = ure - vre;
        im[i + j + len / 2] = uim - vim;
        const nre = curre * wre - curim * wim;
        curim = curre * wim + curim * wre;
        curre = nre;
      }
    }
  }
}

const hzToMel = (hz: number): number => 2595 * Math.log10(1 + hz / 700);
const melToHz = (mel: number): number => 700 * 10 ** (mel / 2595) - 700;

/** Banco de filtros triangulares mel, normalizado por fila. */
export function melFilterbank(
  bands = SPK_MEL_BANDS,
  nfft = SPK_NFFT,
  sampleRate = SPK_SAMPLE_RATE,
): Float64Array[] {
  const lowMel = hzToMel(20);
  const highMel = hzToMel(sampleRate / 2);
  const points: number[] = [];
  for (let i = 0; i < bands + 2; i++) {
    const hz = melToHz(lowMel + ((highMel - lowMel) * i) / (bands + 1));
    points.push(Math.floor(((nfft + 1) * hz) / sampleRate));
  }
  const filters: Float64Array[] = [];
  for (let m = 1; m <= bands; m++) {
    const left = points[m - 1] ?? 0;
    const center = points[m] ?? 0;
    const right = points[m + 1] ?? 0;
    const row = new Float64Array(nfft / 2 + 1);
    for (let k = left; k < center; k++) {
      if (center > left) row[k] = (k - left) / (center - left);
    }
    for (let k = center; k <= right; k++) {
      if (right > center) row[k] = (right - k) / (right - center);
    }
    filters.push(row);
  }
  return filters;
}

const HANN = new Float64Array(SPK_FRAME);
for (let i = 0; i < SPK_FRAME; i++) {
  HANN[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (SPK_FRAME - 1)));
}

/**
 * Embedding log-mel: energías log por banda, pooling media+std por banda,
 * normalizado L2. Determinista, sin estado entre llamadas.
 */
export function extractLogMelEmbedding(
  samples: Float32Array,
  filterbank: Float64Array[] = melFilterbank(),
): Float32Array {
  const nFrames = Math.floor((samples.length - SPK_FRAME) / SPK_HOP) + 1;
  if (nFrames < 3) {
    throw new Error(
      `audio demasiado corto para verificar la voz (${(samples.length / SPK_SAMPLE_RATE).toFixed(2)}s; mínimo ${SPK_MIN_SECONDS}s con voz)`,
    );
  }
  const bands = filterbank.length;
  const sum = new Float64Array(bands);
  const sumSq = new Float64Array(bands);
  const re = new Float64Array(SPK_NFFT);
  const im = new Float64Array(SPK_NFFT);
  for (let f = 0; f < nFrames; f++) {
    const off = f * SPK_HOP;
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < SPK_FRAME; i++) re[i] = (samples[off + i] ?? 0) * (HANN[i] ?? 0);
    fftRadix2(re, im);
    for (let b = 0; b < bands; b++) {
      const row = filterbank[b];
      if (!row) continue;
      let e = 0;
      for (let k = 0; k < row.length; k++) {
        const w = row[k] ?? 0;
        if (w === 0) continue;
        e += w * ((re[k] ?? 0) ** 2 + (im[k] ?? 0) ** 2);
      }
      const v = Math.log(e + 1e-10);
      sum[b] = (sum[b] ?? 0) + v;
      sumSq[b] = (sumSq[b] ?? 0) + v * v;
    }
  }
  const out = new Float32Array(bands * 2);
  let norm = 0;
  for (let b = 0; b < bands; b++) {
    const mean = (sum[b] ?? 0) / nFrames;
    const variance = Math.max(0, (sumSq[b] ?? 0) / nFrames - mean * mean);
    out[b] = mean;
    out[bands + b] = Math.sqrt(variance);
    norm += mean * mean + variance;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) / norm;
  return out;
}

/** Extractor por defecto (log-mel pooled). */
export const logMelExtractor: SpeakerExtractor = {
  extract: (samples) => extractLogMelEmbedding(samples),
};

const cosine = (a: Float32Array, b: Float32Array): number => {
  let dot = 0;
  for (let i = 0; i < a.length && i < b.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
};

export interface SpeakerVerifierOptions {
  threshold?: number;
  margin?: number;
  extractor?: SpeakerExtractor;
}

/**
 * Almacén de perfiles de voz enrolados + verificación. El fichero se guarda
 * atómicamente (temp + rename) tras cada cambio.
 */
export class SpeakerVerifier {
  readonly threshold: number;
  readonly margin: number;
  readonly #extractor: SpeakerExtractor;
  readonly #file: string;
  #profiles: StoredProfile[];

  private constructor(file: string, profiles: StoredProfile[], opts: SpeakerVerifierOptions) {
    this.#file = file;
    this.#profiles = profiles;
    this.threshold = opts.threshold ?? SPK_DEFAULT_THRESHOLD;
    this.margin = opts.margin ?? SPK_DEFAULT_MARGIN;
    this.#extractor = opts.extractor ?? logMelExtractor;
  }

  static async load(file: string, opts: SpeakerVerifierOptions = {}): Promise<SpeakerVerifier> {
    let profiles: StoredProfile[] = [];
    try {
      const raw = JSON.parse(await readFile(file, 'utf8')) as StoredFile;
      profiles = (raw.profiles ?? []).filter(
        (p) => typeof p.name === 'string' && Array.isArray(p.embedding) && p.embedding.length > 0,
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('speaker-verify: perfiles ilegibles, empiezo vacío', { error: String(err) });
      }
    }
    return new SpeakerVerifier(
      file,
      profiles.map((p) => ({ ...p, embedding: p.embedding.slice() })),
      opts,
    );
  }

  list(): SpeakerProfileInfo[] {
    return this.#profiles.map((p) => ({
      name: p.name,
      utterances: p.utterances,
      enrolledAt: p.enrolledAt,
    }));
  }

  /**
   * Enrola (o re-enrola) una voz con varios enunciados: el perfil es la media
   * normalizada de sus embeddings. Reemplazo completo a propósito: mezclar
   * muestras viejas y nuevas nunca empeora en silencio.
   */
  async enroll(name: string, utterances: Float32Array[]): Promise<SpeakerProfileInfo> {
    const clean = name.trim();
    if (!clean) throw new Error('el nombre del perfil no puede estar vacío');
    if (utterances.length === 0) throw new Error('hace falta al menos una muestra para enrolar');
    const acc = new Float64Array(SPK_MEL_BANDS * 2);
    for (const u of utterances) {
      const e = await this.#extractor.extract(u);
      for (let i = 0; i < acc.length; i++) acc[i] = (acc[i] ?? 0) + (e[i] ?? 0);
    }
    let norm = 0;
    for (const v of acc) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    const embedding = Array.from(acc, (v) => Number((v / norm).toFixed(6)));
    const info: StoredProfile = {
      name: clean,
      enrolledAt: new Date().toISOString(),
      utterances: utterances.length,
      embedding,
    };
    this.#profiles = [...this.#profiles.filter((p) => p.name !== clean), info];
    await this.save();
    return { name: clean, utterances: info.utterances, enrolledAt: info.enrolledAt };
  }

  async remove(name: string): Promise<boolean> {
    const before = this.#profiles.length;
    this.#profiles = this.#profiles.filter((p) => p.name !== name.trim());
    const changed = this.#profiles.length !== before;
    if (changed) await this.save();
    return changed;
  }

  /**
   * Verifica un enunciado contra TODOS los perfiles: acepta si el mejor coseno
   * supera el umbral y saca `margin` al segundo. Sin perfiles no acepta nada.
   */
  async verify(samples: Float32Array): Promise<VerifyResult> {
    if (this.#profiles.length === 0) {
      return { accepted: false, speaker: null, score: Number.NaN, second: Number.NaN };
    }
    const e = await this.#extractor.extract(samples);
    const scored = this.#profiles
      .map((p) => ({ name: p.name, score: cosine(e, Float32Array.from(p.embedding)) }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best) return { accepted: false, speaker: null, score: Number.NaN, second: Number.NaN };
    const second = scored[1]?.score ?? Number.NaN;
    const marginOk = Number.isNaN(second) || best.score - second >= this.margin;
    return {
      accepted: best.score >= this.threshold && marginOk,
      speaker: best.name,
      score: best.score,
      second,
    };
  }

  async save(): Promise<void> {
    mkdirSync(dirname(this.#file), { recursive: true });
    const payload: StoredFile = { version: 1, profiles: this.#profiles };
    const tmp = `${this.#file}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.#file);
  }
}

/** Umbral/margen desde entorno, con los defaults conservadores del módulo. */
export function speakerGateConfigFromEnv(env: NodeJS.ProcessEnv = process.env): {
  threshold: number;
  margin: number;
} {
  const t = Number(env.PA_SPEAKER_THRESHOLD);
  const m = Number(env.PA_SPEAKER_MARGIN);
  return {
    threshold: Number.isFinite(t) && t > 0 && t < 1 ? t : SPK_DEFAULT_THRESHOLD,
    margin: Number.isFinite(m) && m >= 0 && m < 1 ? m : SPK_DEFAULT_MARGIN,
  };
}
