/**
 * Item A1a — openWakeWord as an in-process ONNX runner (infrastructure only).
 *
 * Why this exists: the current listener (src/voice/wake.ts) detects the wake
 * word by running a full whisper pass over every energy-gated 3s window —
 * 1-2s of CPU per pass, measured on this machine, plus a phonetic-folding
 * matcher because whisper spells "chochi" as "Choci"/"Chuchis"/"Chocchi".
 * openWakeWord does not transcribe at all: three tiny ONNX models score the
 * audio directly.
 *
 * The pipeline replicates the OFFICIAL openWakeWord v0.5.1 streaming path
 * (openwakeword/utils.py, verified line by line):
 *
 *   - Audio is int16-scale PCM (the official code casts int16 to float32
 *     WITHOUT normalising; the melspec model was trained on that scale).
 *     This app carries float [-1,1], so pushFrame converts once: round(x *
 *     32767), clamped to int16 range.
 *   - Per 1280-sample push (80ms), the melspec model sees the LAST 1760
 *     samples (the new 1280 plus a 480-sample lookback), yielding 8 mel
 *     frames — on the very first push there is no lookback yet, so it sees
 *     1280 and yields 5. Frames then pass through spec/10 + 2.
 *   - A sliding 76-frame mel window feeds embedding_model.onnx → one 96-d
 *     embedding per push once the window is full.
 *   - A sliding 16-embedding window feeds the word classifier → one raw
 *     score per push once full. First score on push 25 (~2.0s), then every
 *     80ms.
 *
 * Exactness against the official implementation is not asserted by these
 * words but by scripts/wakeword-parity.*: same real audio through the
 * official Python and through this runner, scores compared push by push
 * (see the PR body for the measured deltas, including a positive clip of
 * the pretrained model's own word — a pipeline that cannot fire is not a
 * pipeline).
 *
 * This is A1a: the runner, the model fetch and the benches. It is NOT wired
 * into the listener — the adoption decision comes in A1b with a custom
 * "chochi" model and a measured FAR/FRR comparison against the current
 * whisper-based matcher (the rule: it only ships if it beats what exists).
 * Scores here are raw; thresholding/calibration is an A1b concern.
 */

import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { log } from '../log.js';

export const OWW_SAMPLE_RATE = 16_000;
/** One push: 80ms at 16kHz. */
export const OWW_FRAME_SAMPLES = 1280;
/** Lookback the official streaming path adds to every push (3×160 samples). */
export const OWW_MEL_LOOKBACK = 480;
/** Samples the melspec model consumes per push in steady state. */
export const OWW_MEL_INPUT = OWW_FRAME_SAMPLES + OWW_MEL_LOOKBACK;
/** Mel bins per frame. */
export const OWW_MEL_BINS = 32;
/** Sliding mel window the embedding model consumes. */
export const OWW_MEL_WINDOW = 76;
/** Sliding embedding window the classifier consumes. */
export const OWW_EMB_WINDOW = 16;
/** Embedding vector size. */
export const OWW_EMB_SIZE = 96;
/**
 * Pushes to the first score: the mel window reaches 76 frames on push 10
 * (5 + 8·9 = 77), the first embedding lands on that same push, and 16
 * embeddings complete on push 25 (~2.0s of audio).
 */
export const OWW_FIRST_SCORE_FRAME = 25;
/** Official transform applied to the melspec output (utils.py v0.5.1). */
export const melTransform = (v: number): number => v / 10 + 2;
/** Official scale: int16 PCM as float32, NOT normalised to [-1,1]. */
export const floatToInt16Scale = (v: number): number =>
  Math.max(-32768, Math.min(32767, Math.round(v * 32767)));

/** Official model release the runner is pinned to (Apache-2.0). */
export const OWW_RELEASE_BASE = 'https://github.com/dscripka/openWakeWord/releases/download/v0.5.1';
/** Shared feature models, required for any word model. */
export const OWW_FEATURE_MODELS = ['melspectrogram.onnx', 'embedding_model.onnx'] as const;

/** A model file smaller than this is a 404 page, not a model. */
const MIN_MODEL_BYTES = 100_000;
/** Word model filenames are plain .onnx basenames — never paths. */
const WORD_MODEL_RE = /^[\w.-]+\.onnx$/;

let tmpCounter = 0;

/** Minimal tensor shape the runner needs — satisfied by onnxruntime-node. */
export interface OwwTensor {
  data: Float32Array;
  dims: readonly number[];
}

/** Minimal session shape — satisfied by onnxruntime-node's InferenceSession. */
export interface OwwSession {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, OwwTensor>): Promise<Record<string, OwwTensor>>;
  release(): Promise<void>;
}

export type OwwSessionFactory = (modelPath: string) => Promise<OwwSession>;

/** Real sessions via onnxruntime-node (already in the dependency tree). */
export const onnxSessionFactory: OwwSessionFactory = async (modelPath) => {
  // createRequire: onnxruntime-node is CommonJS; a static import would tie
  // the module graph to a native binary even in tests that inject fakes.
  const require = createRequire(import.meta.url);
  const ort = require('onnxruntime-node') as typeof import('onnxruntime-node');
  const inner = await ort.InferenceSession.create(modelPath);
  // The runner speaks in plain {data,dims} tensors so tests can fake it; the
  // real runtime demands ort.Tensor instances, so the boundary converts.
  return {
    inputNames: inner.inputNames,
    outputNames: inner.outputNames,
    run: async (feeds) => {
      const real: Record<string, import('onnxruntime-node').Tensor> = {};
      for (const [k, v] of Object.entries(feeds)) {
        real[k] = new ort.Tensor('float32', v.data, [...v.dims]);
      }
      const out = (await inner.run(real)) as Record<
        string,
        { data: Float32Array; dims: readonly number[] }
      >;
      const mapped: Record<string, OwwTensor> = {};
      for (const [k, v] of Object.entries(out)) mapped[k] = { data: v.data, dims: v.dims };
      return mapped;
    },
    release: () => inner.release(),
  };
};

export interface OwwModelPaths {
  melspec: string;
  embedding: string;
  classifier: string;
}

type FetchLike = typeof fetch;

/**
 * Download the shared feature models plus one word model into `dir`,
 * skipping files already present. `wordModelFile` must be a plain .onnx
 * basename (no path segments): it names a file inside `dir`, nothing else.
 * Downloads go to a unique temp file created with `wx` (no clobbering, no
 * symlink games) and renamed into place, so a killed or racing download
 * never leaves a truncated model behind; a body too small to be a model (a
 * 404 page) is an error, not a file.
 */
export async function ensureOwwModels(
  dir: string,
  wordModelFile: string,
  fetchImpl: FetchLike = fetch,
): Promise<OwwModelPaths> {
  if (!WORD_MODEL_RE.test(wordModelFile) || wordModelFile.includes('..')) {
    throw new Error(`wordModelFile debe ser un nombre .onnx simple; recibido: ${wordModelFile}`);
  }
  mkdirSync(dir, { recursive: true });
  const files = [...OWW_FEATURE_MODELS, wordModelFile];
  for (const file of files) {
    const target = join(dir, file);
    if (existsSync(target) && statSync(target).size >= MIN_MODEL_BYTES) continue;
    const url = `${OWW_RELEASE_BASE}/${file}`;
    log.info('oww model download', { url, target });
    const res = await fetchImpl(url);
    if (!res.ok || !res.body) {
      throw new Error(`descarga de modelo oww falló (${res.status}): ${url}`);
    }
    const tmp = `${target}.${process.pid}.${tmpCounter++}.partial`;
    try {
      // res.body is a web stream; buffer it (models are 1-2MB) to keep the
      // download testable, then write with wx so a stale/symlinked temp
      // cannot be clobbered.
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength < MIN_MODEL_BYTES) {
        throw new Error(
          `descarga de modelo oww demasiado pequeña (${buf.byteLength} B, ¿404?): ${url}`,
        );
      }
      await writeFile(tmp, buf, { flag: 'wx' });
      renameSync(tmp, target);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  }
  return {
    melspec: join(dir, OWW_FEATURE_MODELS[0]),
    embedding: join(dir, OWW_FEATURE_MODELS[1]),
    classifier: join(dir, wordModelFile),
  };
}

/**
 * Streaming wake-word scorer replicating the official openWakeWord pipeline.
 * Feed 1280-sample float [-1,1] frames in real time; each push returns the
 * raw classifier score (0..1) once the sliding windows are full, or null
 * during warmup.
 */
export class OwwWakeDetector {
  private readonly sessions: { melspec: OwwSession; embedding: OwwSession; classifier: OwwSession };
  private melWindow: Float32Array[] = [];
  private embWindow: Float32Array[] = [];
  private carry: Float32Array = new Float32Array(0);
  private closed = false;

  private constructor(sessions: {
    melspec: OwwSession;
    embedding: OwwSession;
    classifier: OwwSession;
  }) {
    this.sessions = sessions;
  }

  static async create(opts: {
    modelDir: string;
    wordModelFile: string;
    factory?: OwwSessionFactory;
    fetchImpl?: FetchLike;
  }): Promise<OwwWakeDetector> {
    const paths = await ensureOwwModels(opts.modelDir, opts.wordModelFile, opts.fetchImpl);
    const factory = opts.factory ?? onnxSessionFactory;
    // Sequential, with cleanup: Promise.all would leak the sessions that did
    // open if a later factory rejects.
    const opened: OwwSession[] = [];
    try {
      const melspec = await factory(paths.melspec);
      opened.push(melspec);
      const embedding = await factory(paths.embedding);
      opened.push(embedding);
      const classifier = await factory(paths.classifier);
      opened.push(classifier);
      return new OwwWakeDetector({ melspec, embedding, classifier });
    } catch (err) {
      await Promise.allSettled(opened.map((s) => s.release()));
      throw err;
    }
  }

  /** Test seam: build over pre-made (fake) sessions, no files involved. */
  static overSessions(sessions: {
    melspec: OwwSession;
    embedding: OwwSession;
    classifier: OwwSession;
  }): OwwWakeDetector {
    return new OwwWakeDetector(sessions);
  }

  /** Pushes of audio needed before the first score (~2.0s). */
  get warmupFrames(): number {
    return OWW_FIRST_SCORE_FRAME;
  }

  /** Drop all buffered audio context (e.g. after a long suppression gap). */
  reset(): void {
    this.melWindow = [];
    this.embWindow = [];
    this.carry = new Float32Array(0);
  }

  async pushFrame(frame: Float32Array): Promise<number | null> {
    if (this.closed) throw new Error('OwwWakeDetector cerrado');
    if (frame.length !== OWW_FRAME_SAMPLES) {
      throw new Error(
        `frame oww debe tener ${OWW_FRAME_SAMPLES} muestras; recibido ${frame.length}`,
      );
    }
    // Official scale: int16 PCM as float32. The lookback is part of the model
    // input, so it converts too.
    const scaled = new Float32Array(this.carry.length + OWW_FRAME_SAMPLES);
    for (let i = 0; i < this.carry.length; i++) {
      scaled[i] = floatToInt16Scale(this.carry[i] ?? 0);
    }
    for (let i = 0; i < OWW_FRAME_SAMPLES; i++) {
      scaled[this.carry.length + i] = floatToInt16Scale(frame[i] ?? 0);
    }
    this.carry = frame.slice(OWW_FRAME_SAMPLES - OWW_MEL_LOOKBACK);

    const melName = this.sessions.melspec.inputNames[0] ?? 'input';
    const melOut = await this.sessions.melspec.run({
      [melName]: { data: scaled, dims: [1, scaled.length] },
    });
    const mel = melOut[this.sessions.melspec.outputNames[0] ?? 'output'];
    if (!mel) throw new Error('melspectrogram.onnx no devolvió salida');
    // [1,1,F,32]: F mel frames (5 on the first push, 8 in steady state),
    // each transformed with the official spec/10 + 2.
    const frames = mel.dims[2] ?? 0;
    for (let f = 0; f < frames; f++) {
      const row = new Float32Array(OWW_MEL_BINS);
      for (let b = 0; b < OWW_MEL_BINS; b++) {
        row[b] = melTransform(mel.data[f * OWW_MEL_BINS + b] ?? 0);
      }
      this.melWindow.push(row);
    }
    while (this.melWindow.length > OWW_MEL_WINDOW) this.melWindow.shift();
    if (this.melWindow.length < OWW_MEL_WINDOW) return null;

    const melFlat = new Float32Array(OWW_MEL_WINDOW * OWW_MEL_BINS);
    for (let i = 0; i < OWW_MEL_WINDOW; i++) {
      const row = this.melWindow[i];
      if (row) melFlat.set(row, i * OWW_MEL_BINS);
    }
    const embName = this.sessions.embedding.inputNames[0] ?? 'input_1';
    const embOut = await this.sessions.embedding.run({
      [embName]: { data: melFlat, dims: [1, OWW_MEL_WINDOW, OWW_MEL_BINS, 1] },
    });
    const emb = embOut[this.sessions.embedding.outputNames[0] ?? 'conv2d_19'];
    if (!emb) throw new Error('embedding_model.onnx no devolvió salida');
    this.embWindow.push(new Float32Array(emb.data));
    while (this.embWindow.length > OWW_EMB_WINDOW) this.embWindow.shift();
    if (this.embWindow.length < OWW_EMB_WINDOW) return null;

    const embFlat = new Float32Array(OWW_EMB_WINDOW * OWW_EMB_SIZE);
    for (let i = 0; i < OWW_EMB_WINDOW; i++) {
      const vec = this.embWindow[i];
      if (vec) embFlat.set(vec, i * OWW_EMB_SIZE);
    }
    const clsName = this.sessions.classifier.inputNames[0] ?? 'x.1';
    const clsOut = await this.sessions.classifier.run({
      [clsName]: { data: embFlat, dims: [1, OWW_EMB_WINDOW, OWW_EMB_SIZE] },
    });
    const score = clsOut[this.sessions.classifier.outputNames[0] ?? '53'];
    if (!score || score.data.length === 0) {
      throw new Error('clasificador oww no devolvió score');
    }
    return score.data[0] ?? null;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([
      this.sessions.melspec.release(),
      this.sessions.embedding.release(),
      this.sessions.classifier.release(),
    ]);
  }
}
