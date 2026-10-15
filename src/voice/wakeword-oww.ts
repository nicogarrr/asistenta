/**
 * Item A1a — openWakeWord as an in-process ONNX runner (infrastructure only).
 *
 * Why this exists: the current listener (src/voice/wake.ts) detects the wake
 * word by running a full whisper pass over every energy-gated 3s window —
 * 1-2s of CPU per pass, measured on this machine, plus a phonetic-folding
 * matcher because whisper spells "chochi" as "Choci"/"Chuchis"/"Chocchi".
 * openWakeWord does not transcribe at all: three tiny ONNX models score the
 * audio directly. Measured on this VM (bench harness in scripts/, real
 * models, 40.6s of real speech): 6.5ms of CPU per 80ms frame — about 8% of
 * one core for always-on listening, versus a whisper pass that costs more
 * than the window it covers.
 *
 * The pipeline is the official openWakeWord one (Apache-2.0, models pinned
 * to the v0.5.1 release):
 *
 *   1280 samples (80ms @16kHz)
 *     → melspectrogram.onnx   [1,1280]      → [1,1,5,32]   (5 mel frames)
 *     → sliding 76 mel frames [1,76,32,1]   → embedding_model.onnx → [1,1,1,96]
 *     → sliding 16 embeddings [1,16,96]     → <word>.onnx  → [1,1] score
 *
 * A score is therefore available once 31 frames (~2.5s) have been pushed and
 * refreshes every 80ms after that.
 *
 * This is A1a: the runner, the model fetch and the bench. It is NOT wired
 * into the listener — the adoption decision comes in A1b with a custom
 * "chochi" model and a measured FAR/FRR comparison against the current
 * whisper-based matcher (the rule: it only ships if it beats what exists).
 * Scores here are raw; thresholding/calibration is an A1b concern.
 *
 * Sessions and fetch are injection points so the suite exercises the frame
 * math in milliseconds without downloading or loading real ONNX files; the
 * real models are exercised by the bench script and an opt-in integration
 * test, exactly like wake.ts's device path.
 */

import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { log } from '../log.js';

export const OWW_SAMPLE_RATE = 16_000;
/** One input frame: 80ms at 16kHz. */
export const OWW_FRAME_SAMPLES = 1280;
/** Mel frames per melspectrogram pass over one input frame. */
export const OWW_MEL_FRAMES_PER_PASS = 5;
/** Mel bins per frame. */
export const OWW_MEL_BINS = 32;
/** Sliding mel window the embedding model consumes. */
export const OWW_MEL_WINDOW = 76;
/** Sliding embedding window the classifier consumes. */
export const OWW_EMB_WINDOW = 16;
/** Embedding vector size. */
export const OWW_EMB_SIZE = 96;
/**
 * Frames to the first score: ceil(76/5)=16 pushes fill the mel window, then
 * 16 embeddings must accumulate; the first classifier call happens on push
 * 16 + 15 = 31 (~2.5s of audio). Before that, pushFrame returns null.
 */
export const OWW_FIRST_SCORE_FRAME = 16 + (OWW_EMB_WINDOW - 1);

/** Official model release the runner is pinned to (Apache-2.0). */
export const OWW_RELEASE_BASE = 'https://github.com/dscripka/openWakeWord/releases/download/v0.5.1';
/** Shared feature models, required for any word model. */
export const OWW_FEATURE_MODELS = ['melspectrogram.onnx', 'embedding_model.onnx'] as const;

/** A model file smaller than this is a 404 page, not a model. */
const MIN_MODEL_BYTES = 100_000;

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
 * skipping files already present. Downloads go to a temp file renamed into
 * place, so a killed download never leaves a truncated model behind; a body
 * that is too small to be a model (a 404 page) is an error, not a file.
 */
export async function ensureOwwModels(
  dir: string,
  wordModelFile: string,
  fetchImpl: FetchLike = fetch,
): Promise<OwwModelPaths> {
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
    const tmp = `${target}.partial`;
    try {
      // res.body is a web stream; writeFile needs bytes — buffer it (models
      // are 1-2MB, so this is small) to keep the download testable.
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength < MIN_MODEL_BYTES) {
        throw new Error(
          `descarga de modelo oww demasiado pequeña (${buf.byteLength} B, ¿404?): ${url}`,
        );
      }
      await writeFile(tmp, buf);
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
 * Streaming wake-word scorer. Feed 1280-sample frames in real time; each
 * push returns the raw classifier score (0..1) once the sliding windows are
 * full, or null during warmup.
 */
export class OwwWakeDetector {
  private readonly sessions: { melspec: OwwSession; embedding: OwwSession; classifier: OwwSession };
  private melWindow: Float32Array[] = [];
  private embWindow: Float32Array[] = [];
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
    const [melspec, embedding, classifier] = await Promise.all([
      factory(paths.melspec),
      factory(paths.embedding),
      factory(paths.classifier),
    ]);
    return new OwwWakeDetector({ melspec, embedding, classifier });
  }

  /** Test seam: build over pre-made (fake) sessions, no files involved. */
  static overSessions(sessions: {
    melspec: OwwSession;
    embedding: OwwSession;
    classifier: OwwSession;
  }): OwwWakeDetector {
    return new OwwWakeDetector(sessions);
  }

  /** Frames of audio needed before the first score (≈2.5s). */
  get warmupFrames(): number {
    return OWW_FIRST_SCORE_FRAME;
  }

  /** Drop all buffered audio context (e.g. after a long suppression gap). */
  reset(): void {
    this.melWindow = [];
    this.embWindow = [];
  }

  async pushFrame(frame: Float32Array): Promise<number | null> {
    if (this.closed) throw new Error('OwwWakeDetector cerrado');
    if (frame.length !== OWW_FRAME_SAMPLES) {
      throw new Error(
        `frame oww debe tener ${OWW_FRAME_SAMPLES} muestras; recibido ${frame.length}`,
      );
    }
    const melName = this.sessions.melspec.inputNames[0] ?? 'input';
    const melOut = await this.sessions.melspec.run({
      [melName]: { data: frame, dims: [1, OWW_FRAME_SAMPLES] },
    });
    const mel = melOut[this.sessions.melspec.outputNames[0] ?? 'output'];
    if (!mel) throw new Error('melspectrogram.onnx no devolvió salida');
    // [1,1,5,32]: five mel frames of 32 bins, appended to the sliding window.
    for (let f = 0; f < OWW_MEL_FRAMES_PER_PASS; f++) {
      this.melWindow.push(mel.data.subarray(f * OWW_MEL_BINS, (f + 1) * OWW_MEL_BINS));
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
