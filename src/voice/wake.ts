/**
 * Always-listening wake word, in two stages on purpose.
 *
 * Stage 1 is cheap and runs on every check: a bounded rolling window of the
 * microphone, rejected unless it carries speech-like energy (RMS gate). Stage 2
 * is expensive and runs only on windows that survived stage 1: a full whisper
 * pass, then `matchesWakeWord` on the transcript. A full whisper pass every
 * second is not viable — `onnx-community/whisper-base` takes ~1-2s of CPU per
 * few seconds of audio on this machine (measured, see below), so running it
 * continuously would pin a core and still lag. The gate means silence and quiet
 * room tone never cost an inference.
 *
 * Calibration, measured on this machine with the bundled ffmpeg and the real
 * whisper checkpoint (`paths.models`):
 *
 * - Mic ambient noise: RMS 0.0025 on a quiet stretch, 0.032 during one noisy
 *   stretch. Fed to whisper, that noisy stretch did NOT stay silent: it came
 *   back as " ¿A qué estoy?" — whisper hallucinates confident text on non-speech,
 *   which is exactly how a wake word fires while the user is talking to someone
 *   else. So the energy gate sits at RMS 0.05 (-26 dBFS), above every measured
 *   noise floor and below SAPI Spanish speech (0.057-0.097 across sentences).
 * - Whisper's actual output for Spanish wake speech (SAPI es-ES voice through
 *   the checkpoint, same load path as stt.ts): "ordenador." -> " ordenador",
 *   "El ordenador." -> " El ordenador", "Necesito el ordenador." ->
 *   " Necesito el ordenador.". Note the leading space, the inconsistent
 *   capitalisation, and the sometimes-missing trailing period. The plural
 *   survives ("Ordenadores portátiles." -> " ordenadores portátiles.") and
 *   "ordenador" inside a longer word comes back as that longer word
 *   ("Coordenador del proyecto." -> " Coordinador del proyecto."). Hence
 *   `normaliseForMatch` (accents, case, punctuation, whitespace) and a
 *   whole-token match that can never fire on "coordenador".
 *
 * False positives are worse than false negatives here: a spurious wake runs the
 * agent against whatever was overheard, while a missed wake only costs the user
 * a repeat. Every threshold is biased accordingly — the energy gate is above the
 * noise floor rather than at it, `matchesWakeWord` defaults to the tier that
 * rejects near-misses, and no tier ever matches the wake word inside a longer
 * word.
 *
 * The microphone hears the speakers: `src/voice/tts.ts` synthesises speech that
 * plays out loud, and without `suppress()` around playback the agent transcribes
 * its own answers and wakes itself. That loop is real, not theoretical — call
 * `suppress(playbackMs)` before every playback.
 */

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import { log } from '../log.js';
import { paths } from '../paths.js';
import { listCaptureDevices } from '../screen/media.js';
import { Mutex, withTimeout } from '../utils.js';
import { WHISPER_SAMPLE_RATE } from './audio.js';

/** Same checkpoint as `src/voice/stt.ts`, and for the same reason: `whisper-*.en` cannot do Spanish. */
const DEFAULT_MODEL = 'onnx-community/whisper-base';

/**
 * Default wake word. The user's word for their assistant, in Spanish.
 *
 * "Asistenta" is a rarer word than "ordenador", so Whisper is more likely to come
 * back with a near miss ("asistente", "la asistenta", "asistenta." with the leading
 * space and no stop). That is exactly what the near-miss and truncation tiers below
 * are for, and it is why the default sensitivity is the truncated tier rather than
 * exact: a wake word that only fires on a perfect transcription is a wake word that
 * mostly does not fire.
 */
const DEFAULT_WORD = 'asistenta';

/**
 * Matching tiers. A tier fires when its score >= sensitivity, so sensitivity 1.0
 * accepts only the exact phrase, 0.85 also accepts whisper's truncated tail
 * ("ordenad"), and 0.7 also accepts a one-edit near-miss ("ordenado"). Nothing
 * below 0.7 is a tier: the matcher gets no looser, because every looser rule
 * starts matching real Spanish words that merely sound similar ("ordena"), and
 * the false-positive bias says no.
 */
const SCORE_EXACT = 1;
const SCORE_TRUNCATED = 0.85;
const SCORE_NEAR = 0.7;
const DEFAULT_SENSITIVITY = SCORE_TRUNCATED;

/**
 * Whisper's short-clip truncation is exactly two characters on the documented
 * variant ("ordenador" -> "ordenad"), and the truncation tier accepts only that.
 * A one-character cut is deliberately not in this tier: it lands on real Spanish
 * words ("ordenado" — "he ordenado la mesa") as often as on a cut transcription,
 * while "ordenad" is not a word at all. One-character cuts are near-misses and
 * sit in the tier below the default.
 */
const TRUNCATION_DROP_CHARS = 2;

/** Near-miss tokens stay within two characters of the target; further away is a different word ("ordenar"). */
const MAX_NEAR_LENGTH_DELTA = 2;

/** One whisper pass at most every this-many ms. 1.5s is ~the pass cost, so checks stay behind real time. */
const DEFAULT_CHECK_INTERVAL_MS = 1_500;

/**
 * Floor for the check interval. Below ~100ms the interval stops being a rate
 * limit and becomes a spin, and every tick can trigger a full whisper pass.
 */
const MIN_CHECK_INTERVAL_MS = 100;

/**
 * Rolling window whisper sees. 3s fits a whole wake utterance (~1-2s) plus
 * context; the ring is capped at exactly this so an always-on listener cannot
 * accumulate hours of audio. Nothing older is kept because it can no longer
 * contain a wake that has not been checked yet.
 */
const WINDOW_SECONDS = 3;

/**
 * Stage-1 gate, RMS in float [-1, 1]. See the module comment for the measured
 * noise floors this sits between. This is deliberately ~5x `looksSilent`'s
 * 0.01 in audio.ts: that one rejects digital silence for note playback, while
 * 0.032 of ordinary room noise already makes whisper hallucinate a sentence.
 *
 * A real VAD (e.g. Silero) would separate speech from music and fan noise by
 * spectrum instead of by loudness, and would reject a loud non-speech window
 * that this gate lets through. It is not worth it here: another ONNX session
 * and feature pipeline to save maybe a tenth of the stage-2 calls, when
 * `matchesWakeWord` is already the false-positive filter that matters. Loud
 * non-speech reaching whisper costs CPU, not correctness.
 */
const ENERGY_GATE_RMS = 0.05;

/** A transcriber that keeps failing is stopped, not retried every interval forever. */
const MAX_CONSECUTIVE_FAILURES = 3;

/** First-run model load budget, same rationale as stt.ts: a cold download is minutes. */
const LOAD_TIMEOUT_MS = 10 * 60_000;

/**
 * Per-check inference budget. Measured 1-2s per short window on this machine;
 * 30s is generous without letting a wedged pass make the listener deaf and
 * stall the check loop indefinitely (stt.ts's 5-minute budget is for minutes of
 * audio, this is for 3 seconds).
 */
const TRANSCRIBE_TIMEOUT_MS = 30_000;

/** How long `stop()` waits for the capture to exit before warning about a leak. */
const CAPTURE_STOP_TIMEOUT_MS = 3_000;

/** How long ffmpeg gets to prove it could open the device before `start()` is called successful. */
const CAPTURE_START_SETTLE_MS = 2_000;

const FFMPEG: string | null =
  typeof ffmpegStatic === 'string'
    ? ffmpegStatic
    : ((ffmpegStatic as { default?: string }).default ?? null);

/**
 * Strip accents, case and punctuation so whisper's quirks do not decide a wake.
 *
 * Pure and total: any input returns a comparable string. The shape of the input
 * is dictated by what whisper actually returns for Spanish (leading spaces,
 * "Ordenador" vs "ordenador", "ordenador" vs "ordenador."), and by whisper
 * transcribing accented words without accents on bad audio — matching on both
 * sides of an accent-folded string means "¿¡ORDENADOR!?" and "ordenador" are
 * the same wake.
 */
export function normaliseForMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Levenshtein capped at one edit, without building the full matrix. */
function withinOneEdit(heard: string, target: string): boolean {
  if (heard.length === target.length) {
    let diffs = 0;
    for (let i = 0; i < heard.length; i++) {
      if (heard[i] !== target[i]) {
        diffs++;
        if (diffs > 1) return false;
      }
    }
    return diffs === 1;
  }
  if (target.length - heard.length !== 1) return false;
  let i = 0;
  while (i < heard.length && heard[i] === target[i]) i++;
  return heard.slice(i) === target.slice(i + 1);
}

/**
 * How well one heard token matches one target token, as a tier score.
 *
 * Zero means "different word". The asymmetry between truncation (heard shorter
 * than target) and the ban on longer tokens is the substring rule made
 * concrete: "ordenad" is whisper cutting the tail off "ordenador", while
 * "ordenadores", "ordenadora" and "coordenador" are real words that merely
 * contain the wake word, and firing on them is the false-positive failure this
 * whole module is biased against.
 */
function tokenScore(heard: string, target: string): number {
  if (heard === target) return SCORE_EXACT;
  if (heard.length === target.length - TRUNCATION_DROP_CHARS && target.startsWith(heard)) {
    return SCORE_TRUNCATED;
  }
  if (
    heard.length <= target.length &&
    heard.length >= target.length - MAX_NEAR_LENGTH_DELTA &&
    withinOneEdit(heard, target)
  ) {
    return SCORE_NEAR;
  }
  return 0;
}

/**
 * Whether `text` contains the wake word (or wake phrase).
 *
 * Pure: no audio, no state, testable as a matrix. `word` may be a multi-word
 * phrase ("el ordenador"), which then must appear as consecutive tokens.
 * `sensitivity` is the minimum tier score (see the tier constants): 1.0 exact
 * phrase only, 0.85 also "ordenad"-style truncations, 0.7 also one-edit
 * near-misses; values outside 0..1 clamp and nothing below 0.7 exists.
 */
export function matchesWakeWord(
  text: string,
  word: string,
  sensitivity = DEFAULT_SENSITIVITY,
): boolean {
  const heardTokens = normaliseForMatch(text).split(' ').filter(Boolean);
  const targetTokens = normaliseForMatch(word).split(' ').filter(Boolean);
  if (heardTokens.length === 0 || targetTokens.length === 0) return false;

  const threshold = Math.max(0, Math.min(1, sensitivity));
  for (let i = 0; i + targetTokens.length <= heardTokens.length; i++) {
    let score = SCORE_EXACT;
    for (let j = 0; j < targetTokens.length; j++) {
      const token = heardTokens[i + j] ?? '';
      const piece = targetTokens[j] ?? '';
      const tokenMatch = tokenScore(token, piece);
      if (tokenMatch === 0) {
        score = 0;
        break;
      }
      score = Math.min(score, tokenMatch);
    }
    if (score >= threshold) return true;
  }
  return false;
}

/**
 * The part of a heard sentence that is not the wake word.
 *
 * What the listener hands over is a whole window of speech - "Asistenta, pon algo de
 * jazz en YouTube" - and the agent needs the instruction, not the address. Matching
 * is delegated to the same token scoring as `matchesWakeWord`, so the two never
 * disagree about what counted as the wake word: it would be strange for the listener
 * to fire on a phrase and then leave that phrase in the prompt.
 *
 * The *last* occurrence is removed rather than the first. "Asistenta, pon X, y luego
 * Asistena para" has a real command after the second address, and dropping only the
 * leading one keeps it. Falls back to the whole sentence when no occurrence matches,
 * because silently returning an empty request is worse than passing on a stray
 * word.
 */
export function stripWakeWord(
  text: string,
  word: string,
  sensitivity = DEFAULT_SENSITIVITY,
): string {
  // The original tokens, and their accent-folded counterparts. Splitting on the same
  // boundary `normaliseForMatch` uses keeps the two lists the same length, which is
  // what lets a match found in the folded text be reported against the text as it was
  // actually said: "abre YouTube" must reach the model as "abre YouTube" and not as
  // the lowercased "abre youtube", because capitalisation is how a proper noun looks
  // like a proper noun.
  const original = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const heard = original.map((token) => normaliseForMatch(token));
  const target = normaliseForMatch(word).split(' ').filter(Boolean);
  if (original.length === 0 || target.length === 0) return text.trim();

  const threshold = Math.max(0, Math.min(1, sensitivity));
  for (let start = heard.length - target.length; start >= 0; start--) {
    let score = SCORE_EXACT;
    let matched = true;
    for (let offset = 0; offset < target.length; offset++) {
      const tier = tokenScore(heard[start + offset] ?? '', target[offset] ?? '');
      if (tier === 0) {
        matched = false;
        break;
      }
      score = Math.min(score, tier);
    }
    if (matched && score >= threshold) return original.slice(start + target.length).join(' ');
  }
  return text.trim();
}

/**
 * The audio source the listener consumes: 16kHz mono float PCM in capture order.
 *
 * Injected so tests never need a real microphone. The contract that matters:
 * `start` rejects without leaking (a spawn that fails to open the device must
 * not leave a process holding the microphone), and `stop` is idempotent and
 * resolves only once the device is actually released.
 */
export interface WakeCapture {
  start(onChunk: (pcm: Float32Array) => void, onError: (err: Error) => void): Promise<void>;
  stop(): Promise<void>;
}

export interface WakeWordOptions {
  /** Wake word or phrase. Default 'asistenta'. */
  word?: string;
  /** 0..1, the minimum match tier. Default 0.85. */
  sensitivity?: number;
  /** ms between checks, floored at 100. Default 1500. */
  checkIntervalMs?: number;
  /** Called with the transcript that matched. Not awaited: it typically starts a whole agent turn. */
  onWake?: (heard: string) => void | Promise<void>;
  /** Reports capture and transcription failures. Never called from inside a throw. */
  onError?: (err: Error) => void;
  /**
   * Audio source injection point. Not part of the minimal surface: it exists so
   * tests can drive the listener without a microphone, same reasoning as
   * `transcriber`. Defaults to the bundled-ffmpeg DirectShow capture.
   */
  capture?: WakeCapture;
  /**
   * Stage-2 injection point, 16kHz mono float PCM in and text out. Defaults to
   * the local whisper checkpoint. Tests inject a fake rather than vi.mock-ing
   * the model, which would also drag the ONNX runtime into the suite.
   */
  transcriber?: (samples: Float32Array) => Promise<string>;
}

/** The pipeline type, kept structural so the heavy import stays inside a function. */
type WakeAsrPipeline = (
  audio: Float32Array,
  options: { language: string; task: string; chunk_length_s: number; stride_length_s: number },
) => Promise<{ text: string }>;

let pipelineMemo: Promise<WakeAsrPipeline> | null = null;

/**
 * Whisper, memoised process-wide. Same pattern as `src/voice/stt.ts` and the
 * same reason: the promise itself is the memo, so concurrent callers cannot
 * start two downloads or two sessions. This is a second memo rather than a
 * shared one because stt.ts's loader is module-private and this module is not
 * allowed to edit it; if both voice paths run in one process the checkpoint is
 * instantiated twice, which costs memory but not correctness.
 */
function loadWakePipeline(model: string): Promise<WakeAsrPipeline> {
  pipelineMemo ??= (async () => {
    const { LogLevel, env, pipeline } = await import('@huggingface/transformers');
    // Same cache as stt.ts: the model lives in the state dir, never in the repo,
    // and every load after the first is offline.
    env.cacheDir = paths.models;
    env.logLevel = LogLevel.ERROR;
    const pipe = await withTimeout(
      pipeline('automatic-speech-recognition', model, { dtype: 'q8', device: 'cpu' }),
      LOAD_TIMEOUT_MS,
      `whisper model ${model} did not finish loading within ${LOAD_TIMEOUT_MS / 1000}s`,
    );
    log.info('wake stt model ready', { model });
    return pipe as unknown as WakeAsrPipeline;
  })().catch((err: unknown) => {
    // Clear the memo so a flaky first load does not brick the listener forever.
    pipelineMemo = null;
    throw err;
  });
  return pipelineMemo;
}

/** Stage 2: the default transcriber. Forced Spanish, for the reasons in stt.ts. */
async function defaultTranscriber(samples: Float32Array): Promise<string> {
  const pipe = await loadWakePipeline(DEFAULT_MODEL);
  const output = await withTimeout(
    pipe(samples, {
      language: 'spanish',
      task: 'transcribe',
      chunk_length_s: 30,
      stride_length_s: 5,
    }),
    TRANSCRIBE_TIMEOUT_MS,
    `whisper did not finish a wake check within ${TRANSCRIBE_TIMEOUT_MS / 1000}s`,
  );
  return output.text;
}

/**
 * DirectShow capture through the bundled ffmpeg, as raw PCM on stdout.
 *
 * Raw s16le on stdout rather than a file: the listener needs the audio while it
 * is being captured, and a file would need a growing read loop plus a format
 * parser per check. `-ar 16000 -ac 1` makes ffmpeg do the downmix and resample
 * so the ring buffer is whisper-shaped from the first byte.
 *
 * Exported so the capture can be exercised (and its chunk delivery observed)
 * without standing up the whole listener.
 */
export class FfmpegMicCapture implements WakeCapture {
  #child: ChildProcess | null = null;
  #exited: Promise<void> | null = null;
  #carry: number | null = null;
  #stopping = false;
  #started = false;

  async start(onChunk: (pcm: Float32Array) => void, onError: (err: Error) => void): Promise<void> {
    if (this.#started) return;
    if (!FFMPEG) throw new Error('no encuentro ffmpeg para capturar audio.');

    const devices = await listCaptureDevices();
    if (!devices.audio) throw new Error('no encuentro ningun microfono en este ordenador.');
    const device = devices.audio;

    const child = spawn(
      FFMPEG,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'dshow',
        '-i',
        `audio=${device}`,
        '-ac',
        '1',
        '-ar',
        String(WHISPER_SAMPLE_RATE),
        // The s16le muxer fixes the codec to pcm_s16le; only the container shape
        // is requested here.
        '-f',
        's16le',
        '-',
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.#child = child;
    this.#started = true;
    this.#stopping = false;

    let stderrTail = '';
    child.stderr?.on('data', (c: Buffer) => {
      // ffmpeg is chatty on failure and silent on success; only the tail is kept,
      // the same shape src/screen/media.ts uses for its run() helper.
      stderrTail = (stderrTail + c.toString('utf8')).slice(-4000);
    });

    let firstData: (() => void) | null = null;
    const ready = new Promise<void>((resolve) => {
      firstData = resolve;
    });

    child.stdout?.on('data', (c: Buffer) => {
      const samples = this.#toSamples(c);
      if (samples.length > 0) {
        firstData?.();
        onChunk(samples);
      }
    });

    this.#exited = new Promise<void>((resolve) => {
      child.on('close', (code) => {
        this.#child = null;
        resolve();
        // Unexpected death (mic unplugged, device seized mid-run): report once and
        // let the listener stop. Restarting here is the hot loop this design
        // refuses — a device that just died busy will die busy again immediately.
        if (!this.#stopping) {
          onError(new Error(captureFailureMessage(device, code, stderrTail)));
        }
      });
    });

    child.on('error', (err) => {
      onError(new Error(`no puedo capturar audio del microfono: ${err.message}`));
    });

    // Settle: dshow opens the device at spawn time and any failure surfaces as an
    // early exit on stderr, not as a spawn error. Racing first-data against the
    // exit means `start()` only resolves when the device is genuinely streaming.
    const settled = await Promise.race([
      ready.then(() => 'ready' as const),
      this.#exited.then(() => 'gone' as const),
      new Promise<'quiet'>((resolve) => {
        const timer = setTimeout(() => resolve('quiet'), CAPTURE_START_SETTLE_MS);
        timer.unref?.();
      }),
    ]);

    if (settled === 'gone') {
      this.#started = false;
      throw new Error(captureFailureMessage(device, null, stderrTail));
    }
  }

  /**
   * s16le bytes to floats, carrying a half-sample across chunks. A stdout chunk
   * can split a 16-bit sample down the middle; dropping the odd byte would
   * desynchronise every later sample into noise.
   */
  #toSamples(chunk: Buffer): Float32Array {
    let bytes = chunk;
    if (this.#carry !== null) {
      bytes = Buffer.concat([Buffer.from([this.#carry]), chunk]);
      this.#carry = null;
    }
    if (bytes.length % 2 === 1) {
      this.#carry = bytes[bytes.length - 1] ?? null;
      bytes = bytes.subarray(0, bytes.length - 1);
    }
    const samples = new Float32Array(bytes.length / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2) / 32768;
    return samples;
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#started = false;
    const child = this.#child;
    if (!child) return;
    // kill() on Windows is TerminateProcess: unconditional, nothing to flush. The
    // resolve of stop() waits for the exit event below, not for this call — the
    // OS releases the DirectShow handle when the process dies, so resolving any
    // earlier is how "another app cannot open the microphone after stop()" bugs
    // happen.
    child.kill();
    child.stdout?.destroy();
    child.stderr?.destroy();
    await withTimeout(
      this.#exited ?? Promise.resolve(),
      CAPTURE_STOP_TIMEOUT_MS,
      `ffmpeg no libero el microfono en ${CAPTURE_STOP_TIMEOUT_MS / 1000}s`,
    ).catch((err: unknown) => {
      log.warn('wake capture stop', { error: err instanceof Error ? err.message : String(err) });
    });
  }
}

/** Spanish message for the two ways dshow fails to hand us a microphone. */
function captureFailureMessage(device: string, code: number | null, stderrTail: string): string {
  const detail = stderrTail.trim();
  if (/0x800700aa|resource is in use|device.*busy|being used/i.test(detail)) {
    return `el microfono "${device}" esta ocupado por otro programa; no hago reintentos automaticos`;
  }
  const tail = detail.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
  const suffix = code === null ? '' : ` (ffmpeg salio con ${code})`;
  return tail
    ? `no puedo capturar audio del microfono "${device}"${suffix}: ${tail}`
    : `no puedo capturar audio del microfono "${device}"${suffix}`;
}

/** Bounded ring of the last `WINDOW_SECONDS` of audio. */
class SampleRing {
  #buf: Float32Array;
  #head = 0;
  #filled = 0;

  constructor(capacity: number) {
    this.#buf = new Float32Array(capacity);
  }

  push(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      this.#buf[this.#head] = samples[i] ?? 0;
      this.#head = (this.#head + 1) % this.#buf.length;
    }
    this.#filled = Math.min(this.#filled + samples.length, this.#buf.length);
  }

  snapshot(): Float32Array {
    const out = new Float32Array(this.#filled);
    const start = (this.#head - this.#filled + this.#buf.length) % this.#buf.length;
    for (let i = 0; i < this.#filled; i++) out[i] = this.#buf[(start + i) % this.#buf.length] ?? 0;
    return out;
  }

  clear(): void {
    this.#head = 0;
    this.#filled = 0;
  }
}

/** Stage 1: RMS of a window. Cheap enough to run on every check, unlike the model. */
function windowRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i] ?? 0;
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}

export class WakeWordListener {
  #word: string;
  #sensitivity: number;
  #checkIntervalMs: number;
  #onWake: ((heard: string) => void | Promise<void>) | undefined;
  #onError: ((err: Error) => void) | undefined;
  #capture: WakeCapture;
  #transcriber: (samples: Float32Array) => Promise<string>;

  #lock = new Mutex();
  #ring = new SampleRing(WHISPER_SAMPLE_RATE * WINDOW_SECONDS);
  #running = false;
  #captureActive = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #suppressedUntil = 0;
  #checks = 0;
  #wakeCount = 0;
  #lastWakeAt: string | null = null;
  #suppressed = 0;
  #consecutiveFailures = 0;
  /**
   * Last transcript that did not contain the wake word.
   *
   * A custom word is the normal case, not the exception: whisper has no vocabulary for
   * "chochi" and will transcribe it as whatever is phonetically nearest, so the listener
   * needs to be able to show what it actually heard instead of staying silent.
   */
  #lastHeard = '';

  constructor(opts: WakeWordOptions = {}) {
    this.#word = opts.word ?? DEFAULT_WORD;
    this.#sensitivity = Math.max(0, Math.min(1, opts.sensitivity ?? DEFAULT_SENSITIVITY));
    this.#checkIntervalMs = Math.max(
      MIN_CHECK_INTERVAL_MS,
      Math.trunc(opts.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS),
    );
    this.#onWake = opts.onWake;
    this.#onError = opts.onError;
    this.#capture = opts.capture ?? new FfmpegMicCapture();
    this.#transcriber = opts.transcriber ?? defaultTranscriber;
  }

  isRunning(): boolean {
    return this.#running;
  }

  /**
   * What the listener has actually been hearing: `checks` counts windows that
   * cleared the energy gate and reached the transcriber (0 while the room is
   * silent is healthy, not a hang), `suppressed` counts checks dropped because
   * the agent was speaking, `wakeCount`/`lastWakeAt` report detections.
   */
  stats(): {
    checks: number;
    wakeCount: number;
    lastWakeAt: string | null;
    suppressed: number;
    lastHeard: string;
  } {
    return {
      checks: this.#checks,
      wakeCount: this.#wakeCount,
      lastWakeAt: this.#lastWakeAt,
      lastHeard: this.#lastHeard,
      suppressed: this.#suppressed,
    };
  }

  /**
   * Suppress detection, e.g. while tts.ts plays out loud. Repeated calls extend
   * to cover the longest playback rather than resetting, and audio captured
   * while suppressed is dropped entirely so the window cannot hold the agent's
   * own voice when detection resumes. Without this the microphone hears the
   * speakers and the agent wakes itself — say "ordenador" once and it answers
   * itself forever.
   */
  suppress(ms: number): void {
    const until = Date.now() + Math.max(0, ms);
    if (until > this.#suppressedUntil) this.#suppressedUntil = until;
    this.#ring.clear();
  }

  async start(): Promise<void> {
    await this.#lock.run(async () => {
      if (this.#running) return;
      if (normaliseForMatch(this.#word).length === 0) {
        throw new Error('la palabra de activacion esta vacia');
      }
      this.#running = true;
      this.#captureActive = true;
      this.#consecutiveFailures = 0;
      try {
        await this.#capture.start(
          (pcm) => this.#handleChunk(pcm),
          (err) => this.#handleCaptureError(err),
        );
      } catch (err) {
        // The capture is contractually clean after a failed start (it kills any
        // spawn it made). No retry here on purpose: against a busy microphone a
        // retry loop is pure CPU and log noise, and the caller is told plainly.
        this.#running = false;
        this.#captureActive = false;
        throw err;
      }
      this.#scheduleCheck();
    });
  }

  /**
   * Idempotent: safe to call twice, safe before start(). Resolves only once the
   * capture process is gone, so a caller can hand the microphone to another app
   * as soon as this settles.
   */
  async stop(): Promise<void> {
    await this.#lock.run(async () => {
      this.#running = false;
      if (this.#timer) {
        clearTimeout(this.#timer);
        this.#timer = null;
      }
      this.#ring.clear();
      if (this.#captureActive) {
        this.#captureActive = false;
        await this.#capture.stop();
      }
    });
  }

  #handleChunk(pcm: Float32Array): void {
    // Chunks that arrive after stop() (a dying ffmpeg, an injected capture with a
    // sloppy shutdown) must not resurrect the window.
    if (!this.#running) return;
    if (Date.now() < this.#suppressedUntil) return;
    this.#ring.push(pcm);
  }

  #handleCaptureError(err: Error): void {
    this.#reportError(err);
    // Stop rather than restart: see the close handler in FfmpegMicCapture.
    void this.stop().catch((stopErr: unknown) => this.#reportError(stopErr));
  }

  #scheduleCheck(): void {
    if (!this.#running) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#tick();
    }, this.#checkIntervalMs);
    this.#timer.unref?.();
  }

  /**
   * One check cycle. Checks never overlap: the next one is scheduled after this
   * one finishes, so a slow whisper pass delays the next check instead of
   * queueing a backlog of them (bounded CPU, the second constraint this design
   * exists for).
   */
  async #tick(): Promise<void> {
    try {
      if (!this.#running) return;
      if (Date.now() < this.#suppressedUntil) {
        this.#suppressed++;
        return;
      }
      const window = this.#ring.snapshot();
      if (window.length === 0) return;
      if (windowRms(window) < ENERGY_GATE_RMS) return;

      let text: string;
      try {
        text = await this.#transcriber(window);
        this.#consecutiveFailures = 0;
      } catch (err) {
        this.#consecutiveFailures++;
        this.#reportError(err);
        if (this.#consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          this.#reportError(
            new Error(
              `detengo el oyente tras ${MAX_CONSECUTIVE_FAILURES} fallos de transcripcion seguidos`,
            ),
          );
          await this.stop();
        }
        return;
      }

      // stop() during the transcription: the result is stale, discard it.
      if (!this.#running) return;
      this.#checks++;
      if (!matchesWakeWord(text, this.#word, this.#sensitivity)) {
        // Why the word did not fire is otherwise invisible: the listener stays silent and
        // the user concludes the microphone is broken. A custom wake word makes this
        // routine, because whisper has no idea "chochi" is a word and will happily
        // transcribe it as something else.
        this.#lastHeard = text;
        this.#reportError(
          new Error(`no he oido la palabra de activacion; he transcrito: "${text}"`),
        );
        return;
      }

      this.#wakeCount++;
      this.#lastWakeAt = new Date().toISOString();
      // The window still holds the utterance that just fired; without clearing it
      // the next check transcribes the same audio and wakes twice per sentence.
      this.#ring.clear();
      this.#fireWake(text);
    } finally {
      this.#scheduleCheck();
    }
  }

  #fireWake(text: string): void {
    if (!this.#onWake) return;
    try {
      // Not awaited: onWake typically starts a whole agent turn, and holding the
      // check loop hostage to it would make the listener deaf for its duration.
      void Promise.resolve(this.#onWake(text)).catch((err: unknown) => this.#reportError(err));
    } catch (err) {
      this.#reportError(err);
    }
  }

  #reportError(err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err));
    log.warn('wake word listener', { error: error.message });
    try {
      this.#onError?.(error);
    } catch {
      // A throwing onError must not take the check loop down with it.
    }
  }
}
