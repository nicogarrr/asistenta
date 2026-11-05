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
import { modoAhorro } from '../ahorro.js';
import { childEnv } from '../child-env.js';
import { log } from '../log.js';
import { listCaptureDevices } from '../screen/media.js';
import { Mutex, withTimeout } from '../utils.js';
import { WHISPER_SAMPLE_RATE } from './audio.js';
import { loadWhisperPipeline, SMALL_STT_MODEL } from './stt.js';
import { OWW_FRAME_SAMPLES, OwwWakeDetector } from './wakeword-oww.js';

/**
 * whisper-small (el respaldo de las notas de voz, compartido en memoria con ellas): la
 * palabra de activación necesita una pasada rápida y multilingüe, no el modelo grande.
 */
const DEFAULT_MODEL = SMALL_STT_MODEL;

/**
 * Default wake word. The user's word for their assistant, in Spanish.
 *
 * "Asistenta" is a rarer word than "ordenador", so Whisper is more likely to come
 * back with a near miss ("asistente", "la asistenta", "asistenta." with the leading
 * space and no stop). That is exactly what the near-miss and truncation tiers below
 * are for, and the default sensitivity sits looser still, at the phonetic tier (see
 * DEFAULT_SENSITIVITY): a wake word that only fires on a perfect transcription is a
 * wake word that mostly does not fire.
 */
const DEFAULT_WORD = 'asistenta';

/**
 * Matching tiers. A tier fires when its score >= sensitivity, so sensitivity 1.0
 * accepts only the exact phrase, 0.85 also accepts whisper's two-character
 * truncated tail ("asistent"), and 0.7 also accepts a one-edit near-miss. With
 * the default word that near-miss is "asistente" - a real Spanish word, so the
 * near tier knowingly admits one; the false-positive bias is why nothing looser
 * than 0.7 exists (below it, rules start matching words that merely sound
 * similar, "asiste"), apart from the phonetic fold the default sits on.
 */
const SCORE_EXACT = 1;
const SCORE_TRUNCATED = 0.85;
const SCORE_NEAR = 0.7;
/**
 * Phonetic tier, for words whisper has no vocabulary for. A custom wake word
 * ("chochi") is not Spanish, so whisper spells it by ear: measured on this
 * machine, "Chochi reproduce Jingle Bells" came back as "Choci", "Chuchis" and
 * "Chocchi" — all two or more edits away, beyond the one-edit tier. Folding both
 * sides to a rough Spanish phonetic shape makes those the same token while still
 * rejecting real words that merely start alike ("chico", "chocolate").
 */
export const SCORE_PHONETIC = 0.55;
/**
 * Default sensitivity: the phonetic tier. A custom word is the normal case, not
 * the exception — whisper has no vocabulary for "chochi" and spells it "Choci",
 * "Chuchis" or "Chocchi", all beyond one edit. The phonetic tier catches the
 * first two by exact fold equality; real words that merely sound alike
 * ("coche"->"koke", "chico"->"kiko") fold differently and stay out.
 */
const DEFAULT_SENSITIVITY = SCORE_PHONETIC;

/**
 * Whisper's short-clip truncation is exactly two characters on the documented
 * variant ("ordenador" -> "ordenad"), and the truncation tier accepts only that.
 * A one-character cut is deliberately not in this tier: it lands on real Spanish
 * words ("ordenado" — "he ordenado la mesa") as often as on a cut transcription,
 * while "ordenad" is not a word at all. One-character cuts are near-misses at
 * 0.7 - above the phonetic default (0.55), so the default admits them too;
 * they drop out only when the caller raises sensitivity past 0.7.
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
 * Modo ahorro (`PA_AHORRO=1`): con ruido en la sala (tele, música) cada comprobación es una
 * pasada de whisper-small (~3–4 s de CPU), y con la ventana de 3 s cada 1,5 s todo el audio
 * se transcribe dos veces. En ahorro se comprueba cada 3 s con una ventana de 4,5 s: la
 * mitad de pasadas (el coste de whisper no depende de si son 3 o 4,5 s de audio) y 1,5 s de
 * solape, más que lo que dura decir «asistenta», así que la palabra siempre cae entera en
 * alguna ventana. A cambio, puede tardar hasta 1,5 s más en reaccionar. Sin la variable,
 * todo igual que siempre.
 */
export function wakeTiming(env: NodeJS.ProcessEnv = process.env): {
  checkIntervalMs: number;
  windowSeconds: number;
} {
  return modoAhorro(env)
    ? { checkIntervalMs: 3_000, windowSeconds: 4.5 }
    : { checkIntervalMs: DEFAULT_CHECK_INTERVAL_MS, windowSeconds: WINDOW_SECONDS };
}

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

/** Tramo de 100 ms para medir si el audio nuevo de verdad es silencio (ver `alreadySeen`). */
const FRAME_SAMPLES = 1_600;

/** Final de ventana (300 ms) que tiene que estar en silencio para dar la palabra por vista entera. */
const TAIL_SAMPLES = 4_800;

/** A transcriber that keeps failing is stopped, not retried every interval forever. */
const MAX_CONSECUTIVE_FAILURES = 3;

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

/**
 * Rough Spanish phonetic folding, so a word whisper has never seen still matches.
 *
 * "Chochi" comes back as "Choci", "Chuchis" or "Chocchi"; folded, all of them are
 * "kochi". The folds are the ones Spanish actually does: ch/c/qu -> k, g/j -> j,
 * b/v -> b, y/ll -> i, h silent, z/c(e,i) -> s, double letters collapsed. It is
 * deliberately coarse — this tier only exists for custom words, and the
 * false-positive bias is carried by requiring the whole token to fold equal, not
 * by any prefix or substring rule.
 */
function phoneticFold(token: string): string {
  let out = '';
  let prev = '';
  for (const raw of token) {
    const ch = raw;
    let folded = ch;
    if (ch === 'h') continue;
    if (ch === 'c') folded = 'k';
    else if (ch === 'g') folded = 'j';
    else if (ch === 'v') folded = 'b';
    else if (ch === 'y' || ch === 'l') folded = 'i';
    else if (ch === 'z') folded = 's';
    else if (ch === 'q') folded = 'k';
    if (folded === prev) continue;
    out += folded;
    prev = folded;
  }
  return out;
}

/**
 * Levenshtein capped at one edit, without building the full matrix.
 *
 * Deletion and substitution only: an insertion is the same edit seen from the
 * other side, and callers always pass the shorter string first.
 */
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
  // Custom words only: whisper spells "chochi" as "choci"/"chocchi", both beyond
  // one edit. Folding both sides to a Spanish phonetic shape makes them equal;
  // real words that merely sound alike ("chico", "coche") fold differently.
  // Exact equality only: a one-edit tolerance on the folded form matches "coche".
  if (phoneticFold(heard) === phoneticFold(target)) {
    return SCORE_PHONETIC;
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
 * near-misses, 0.55 also the phonetic tier for custom words; values outside
 * 0..1 clamp and nothing below 0.55 exists.
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
 * jazz en YouTube" - and the agent needs the instruction, not the address. Scoring
 * is shared with `matchesWakeWord`, but the default bar is stricter (truncation
 * tier) than the listener's (phonetic tier): detection is recall-biased because
 * whisper mangles custom words, while stripping is precision-biased because a
 * one-edit slip like "Asistena" mid-sentence is more likely real speech than the
 * address. Silently eating the command up to a slip is worse than leaving a stray
 * word for the model, which copes with the stray word.
 *
 * The *last* occurrence is removed rather than the first. "Asistenta, pon X, y luego
 * Asistena para" has a real command after the second address, and dropping only the
 * leading one keeps it. Falls back to the whole sentence when no occurrence matches,
 * because silently returning an empty request is worse than passing on a stray
 * word.
 */
export function stripWakeWord(text: string, word: string, sensitivity = SCORE_TRUNCATED): string {
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

/** Motor de deteccion de la palabra de activacion. */
export type WakeEngine = 'whisper' | 'oww';

/**
 * Ajustes del motor 'oww' (runner openWakeWord dedicado, A1a/A1b). A
 * diferencia del motor whisper, oww NO transcribe: puntua cada frame de
 * 80ms con tres modelos ONNX pequenos, asi que el coste por segundo de
 * audio es minusculo y constante, sin pasada whisper por ventana.
 */
export interface OwwWakeOptions {
  /** Dir con melspectrogram.onnx, embedding_model.onnx y el modelo de palabra. */
  modelDir: string;
  /**
   * Nombre simple .onnx del modelo de palabra entrenado con
   * scripts/wakeword-train.py (ruta completa en docs/wakeword-oww.md).
   */
  wordModelFile: string;
  /** Score del clasificador que cuenta como deteccion (0..1). Defecto 0.5. */
  threshold?: number;
  /** Costura de tests: detector ya construido, sin sesiones ONNX reales. */
  detector?: OwwWakeDetector;
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
  transcriber?: (samples: Float32Array, initialPrompt?: string) => Promise<string>;
  /**
   * Whisper `initial_prompt`: biases the decoder toward these words. Set it to a
   * custom wake word so whisper copies the spelling instead of inventing one.
   * Ignored by injected transcribers, which is what the tests use.
   */
  initialPrompt?: string;
  /**
   * Raw audio tap (capability 6). Called with every captured chunk while the listener
   * runs, before the suppression and hold checks, so a conversation session can own the
   * stream without opening a second capture on a device that only allows one.
   */
  onAudio?: (pcm: Float32Array) => void;
  /**
   * Motor de deteccion. Defecto 'whisper' (transcribir y comparar texto).
   * 'oww' usa el runner openWakeWord dedicado y requiere `oww`; detras de
   * flag (PA_WAKE_ENGINE) hasta medir FAR/FRR contra whisper en su PC.
   */
  engine?: WakeEngine;
  /** Requerido cuando engine es 'oww'. */
  oww?: OwwWakeOptions;
}

/** The pipeline type, kept structural so the heavy import stays inside a function. */
type WakeAsrPipeline = (
  audio: Float32Array,
  options: {
    language: string;
    task: string;
    chunk_length_s: number;
    stride_length_s: number;
    initial_prompt?: string;
  },
) => Promise<{ text: string }>;

/**
 * Whisper, compartido con las notas de voz (`loadWhisperPipeline` de stt.ts): el
 * mismo checkpoint en el mismo proceso se carga una sola vez. Antes había un memo
 * aparte aquí y, con la palabra de activación y las notas de voz a la vez, el
 * modelo vivía dos veces en memoria.
 */
function loadWakePipeline(model: string): Promise<WakeAsrPipeline> {
  return loadWhisperPipeline(model) as unknown as Promise<WakeAsrPipeline>;
}

/**
 * Stage 2: the default transcriber. Forced Spanish, for the reasons in stt.ts.
 *
 * `initialPrompt` is whisper's own hint: it biases the decoder toward those words
 * instead of letting it spell a custom wake word by ear. Measured on this machine,
 * "Chochi reproduce Jingle Bells" came back as "Choci", "Chuchis", "Chocchi" or
 * with the word dropped entirely ("reproduce Jingle Bells"); with the prompt set
 * to the wake word itself, whisper has a spelling to copy.
 */
export async function defaultTranscriber(
  samples: Float32Array,
  initialPrompt?: string,
): Promise<string> {
  const pipe = await loadWakePipeline(DEFAULT_MODEL);
  const output = await withTimeout(
    pipe(samples, {
      language: 'spanish',
      task: 'transcribe',
      chunk_length_s: 30,
      stride_length_s: 5,
      ...(initialPrompt ? { initial_prompt: initialPrompt } : {}),
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
    if (!FFMPEG)
      throw new Error('no encuentro ffmpeg, el programa con el que grabo el audio del micrófono.');

    const devices = await listCaptureDevices();
    if (!devices.audio) throw new Error('no encuentro ningún micrófono en este ordenador.');
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
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() },
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
      // El detalle técnico va al registro; al chat, una frase llana.
      log.warn('wake capture spawn failed', { error: err.message });
      onError(new Error('no puedo usar el micrófono: no arranca el programa que graba el audio.'));
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
      `ffmpeg no liberó el micrófono en ${CAPTURE_STOP_TIMEOUT_MS / 1000} s`,
    ).catch((err: unknown) => {
      log.warn('wake capture stop', { error: err instanceof Error ? err.message : String(err) });
    });
  }
}

/**
 * Spanish message for the two ways dshow fails to hand us a microphone. What
 * ffmpeg printed (exit code, stderr tail) goes to the log, not to the chat.
 */
export function captureFailureMessage(
  device: string,
  code: number | null,
  stderrTail: string,
): string {
  const detail = stderrTail.trim();
  if (/0x800700aa|resource is in use|device.*busy|being used/i.test(detail)) {
    return `el micrófono «${device}» está ocupado por otro programa (¿una llamada o una grabación?); no lo reintento solo`;
  }
  const tail = detail.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
  if (tail || code !== null) log.warn('wake capture failed', { device, code, tail });
  return `no puedo usar el micrófono «${device}»: mira que esté conectado y que Windows deje usarlo (Configuración > Privacidad > Micrófono)`;
}

/** Bounded ring of the last `WINDOW_SECONDS` of audio. */
class SampleRing {
  #buf: Float32Array;
  #head = 0;
  #filled = 0;
  /** Muestras recibidas desde que se creó el anillo (nunca baja; clear() no lo toca). */
  #total = 0;
  /** `#total` cuando se copió la última ventana que llegó a whisper; null si no hay ninguna vigente. */
  #seenAt: number | null = null;
  /** Si esa ventana terminaba en silencio (la palabra no quedó cortada por el final). */
  #seenTailQuiet = false;

  constructor(capacity: number) {
    this.#buf = new Float32Array(capacity);
  }

  /**
   * Copia por bloques (como mucho dos `set`), no muestra a muestra con `%`: el micro
   * llega unas 16.000 veces por segundo mientras la palabra de activación escucha,
   * todo el día. Mismo contenido y mismo orden que la copia una a una.
   */
  push(samples: Float32Array): void {
    const cap = this.#buf.length;
    // Un trozo más largo que la ventana: solo cuentan sus últimas `cap` muestras.
    const src = samples.length > cap ? samples.subarray(samples.length - cap) : samples;
    const first = Math.min(src.length, cap - this.#head);
    this.#buf.set(src.subarray(0, first), this.#head);
    if (first < src.length) this.#buf.set(src.subarray(first), 0);
    this.#head = (this.#head + src.length) % cap;
    this.#filled = Math.min(this.#filled + samples.length, cap);
    this.#total += samples.length;
  }

  /**
   * RMS más alto de los tramos de 100 ms entre las `count` muestras más nuevas. Por tramos y
   * no de media: una sílaba corta y fuerte dentro de 3 s de silencio se diluiría en la media.
   */
  #maxFrameRms(count: number): number {
    const n = Math.min(count, this.#filled);
    if (n <= 0) return 0;
    const cap = this.#buf.length;
    const start = (this.#head - n + cap) % cap;
    let max = 0;
    for (let at = 0; at < n; at += FRAME_SAMPLES) {
      const len = Math.min(FRAME_SAMPLES, n - at);
      let sum = 0;
      for (let i = 0; i < len; i++) {
        const sample = this.#buf[(start + at + i) % cap] ?? 0;
        sum += sample * sample;
      }
      const rms = Math.sqrt(sum / len);
      if (rms > max) max = rms;
    }
    return max;
  }

  /** La ventana actual va a whisper: apunta hasta dónde se ha visto y cómo acababa. */
  markSeen(gate: number): void {
    this.#seenAt = this.#total;
    this.#seenTailQuiet = this.#maxFrameRms(TAIL_SAMPLES) < gate;
  }

  /** Esa pasada falló: su ventana no cuenta como vista. */
  forgetSeen(): void {
    this.#seenAt = null;
  }

  /**
   * Consumo: ¿la ventana actual ya la vio whisper entera? Sí cuando no ha llegado audio
   * nuevo desde la última pasada, o cuando todo lo nuevo es silencio y la ventana anterior
   * también acababa en silencio: entonces la ventana de ahora es un trozo de la anterior más
   * silencio, y la palabra (si estaba) ya se vio completa, sin cortar por ningún extremo.
   * Pasa tras cada frase dicha en una sala tranquila: la frase sigue en el anillo 3 s y antes
   * se transcribía otra vez entera, con el mismo resultado.
   */
  alreadySeen(gate: number): boolean {
    if (this.#seenAt === null) return false;
    const fresh = this.#total - this.#seenAt;
    if (fresh === 0) return true;
    if (fresh >= this.#filled || !this.#seenTailQuiet) return false;
    return this.#maxFrameRms(fresh) < gate;
  }

  /**
   * Etapa 1: RMS de la ventana sin copiarla, en el mismo orden (de la más antigua a la más
   * nueva) que sumar sobre `snapshot()`, así que da exactamente el mismo número. La
   * ventana solo se copia cuando pasa la puerta de energía y va a whisper.
   */
  rms(): number {
    if (this.#filled === 0) return 0;
    let sum = 0;
    for (const part of this.#parts()) {
      for (let i = 0; i < part.length; i++) {
        const sample = part[i] ?? 0;
        sum += sample * sample;
      }
    }
    return Math.sqrt(sum / this.#filled);
  }

  /** La ventana en orden (de la más antigua a la más nueva) como uno o dos tramos, sin copiar. */
  #parts(): Float32Array[] {
    const cap = this.#buf.length;
    const start = (this.#head - this.#filled + cap) % cap;
    const end = start + this.#filled;
    if (end <= cap) return [this.#buf.subarray(start, end)];
    return [this.#buf.subarray(start), this.#buf.subarray(0, end - cap)];
  }

  snapshot(): Float32Array {
    const out = new Float32Array(this.#filled);
    let at = 0;
    for (const part of this.#parts()) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  clear(): void {
    this.#head = 0;
    this.#filled = 0;
    this.#seenAt = null;
  }

  get size(): number {
    return this.#filled;
  }
}

export class WakeWordListener {
  #word: string;
  #sensitivity: number;
  #checkIntervalMs: number;
  #onWake: ((heard: string) => void | Promise<void>) | undefined;
  #onError: ((err: Error) => void) | undefined;
  #capture: WakeCapture;
  #transcriber: (samples: Float32Array, initialPrompt?: string) => Promise<string>;
  #initialPrompt: string | undefined;
  #onAudio: ((pcm: Float32Array) => void) | undefined;
  #held = false;
  #engine: WakeEngine;
  #owwOpts: OwwWakeOptions | undefined;
  #oww: OwwWakeDetector | null = null;
  #owwThreshold: number;
  /** Resto de chunk que aun no completa un frame oww de 1280 muestras. */
  #owwCarry = new Float32Array(0);

  #lock = new Mutex();
  #ring: SampleRing;
  #running = false;
  #captureActive = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Sube en cada start() y stop(). Un tick captura la generación al empezar: si al
   * volver de una transcripción lenta ya no coincide, el oyente se paró (y quizá
   * volvió a arrancar) mientras tanto, así que el resultado es de otra sesión y ese
   * tick no puede despertar ni programar otro chequeo (habría dos bucles a la vez).
   */
  #generation = 0;
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

  /** Last non-matching transcript already logged, so a noisy room does not repeat itself. */
  #loggedHeard = '';

  constructor(opts: WakeWordOptions = {}) {
    this.#word = opts.word ?? DEFAULT_WORD;
    this.#sensitivity = Math.max(0, Math.min(1, opts.sensitivity ?? DEFAULT_SENSITIVITY));
    const timing = wakeTiming();
    this.#ring = new SampleRing(Math.round(WHISPER_SAMPLE_RATE * timing.windowSeconds));
    this.#checkIntervalMs = Math.max(
      MIN_CHECK_INTERVAL_MS,
      Math.trunc(opts.checkIntervalMs ?? timing.checkIntervalMs),
    );
    this.#onWake = opts.onWake;
    this.#onError = opts.onError;
    this.#capture = opts.capture ?? new FfmpegMicCapture();
    this.#transcriber = opts.transcriber ?? defaultTranscriber;
    this.#initialPrompt = opts.initialPrompt;
    this.#onAudio = opts.onAudio;
    this.#engine = opts.engine ?? 'whisper';
    if (this.#engine === 'oww' && !opts.oww) {
      throw new Error('el motor oww necesita opts.oww (modelDir y wordModelFile)');
    }
    this.#owwOpts = opts.oww;
    this.#owwThreshold = Math.max(0, Math.min(1, opts.oww?.threshold ?? 0.5));
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
    // La voz del propio agente no puede quedar en las ventanas del detector:
    // reset() invalida tambien los pushes ya encolados (generation), no solo
    // el audio futuro.
    this.#oww?.reset();
    this.#owwCarry = new Float32Array(0);
  }

  /**
   * Hold wake detection while a conversation session owns the microphone: no window is
   * collected or transcribed, so the session's speech cannot fire the wake word again.
   * The capture itself keeps running and the tap keeps receiving audio.
   */
  hold(on: boolean): void {
    this.#held = on;
    this.#ring.clear();
    this.#oww?.reset();
    this.#owwCarry = new Float32Array(0);
  }

  async start(): Promise<void> {
    await this.#lock.run(async () => {
      if (this.#running) return;
      if (normaliseForMatch(this.#word).length === 0) {
        throw new Error('la palabra de activacion esta vacia');
      }
      this.#running = true;
      this.#generation++;
      this.#captureActive = true;
      this.#consecutiveFailures = 0;
      try {
        if (this.#engine === 'oww' && !this.#oww) {
          // Antes de tocar el microfono: si el modelo no esta, el error debe
          // llegar sin dejar una captura a medio abrir. ensureOwwModels baja
          // los feature models solos; el modelo de palabra lo entrena Nico
          // (scripts/wakeword-train.py), y si falta la descarga 404 se
          // convierte aqui en la ruta de entrenamiento, no en un enigma.
          try {
            this.#oww =
              this.#owwOpts?.detector ??
              (await OwwWakeDetector.create({
                modelDir: this.#owwOpts?.modelDir ?? '',
                wordModelFile: this.#owwOpts?.wordModelFile ?? '',
              }));
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            throw new Error(
              `no puedo iniciar el motor oww: ${detail}. Entrena el modelo con ` +
                'scripts/wakeword-train.py y dejalo en el dir de modelos ' +
                '(ruta completa: docs/wakeword-oww.md).',
            );
          }
        }
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
      // El motor oww puntua por frame dentro de #handleChunk: no hay ventana
      // de 3s ni pasada whisper que programar.
      if (this.#engine === 'whisper') this.#scheduleCheck();
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
      this.#generation++;
      if (this.#timer) {
        clearTimeout(this.#timer);
        this.#timer = null;
      }
      this.#ring.clear();
      this.#owwCarry = new Float32Array(0);
      const detector = this.#oww;
      this.#oww = null;
      if (detector) {
        try {
          await detector.close();
        } catch (err) {
          // Un release fallido no puede impedir parar el oyente; el detector
          // conserva las sesiones pendientes y un close posterior reintenta.
          this.#reportError(err);
        }
      }
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
    if (this.#onAudio) {
      try {
        this.#onAudio(pcm);
      } catch (err) {
        this.#reportError(err);
      }
    }
    if (this.#held) return;
    if (Date.now() < this.#suppressedUntil) return;
    if (this.#engine === 'oww') {
      this.#feedOww(pcm);
      return;
    }
    this.#ring.push(pcm);
  }

  /**
   * Trocea el chunk en frames de 1280 muestras (80ms) y los puntua en orden.
   * pushFrame ya serializa internamente, y los scores vuelven en orden de
   * entrega, asi que un frame lento retrasa la decision sin reordenarla.
   */
  #feedOww(pcm: Float32Array): void {
    const detector = this.#oww;
    if (!detector) return;
    const merged = new Float32Array(this.#owwCarry.length + pcm.length);
    merged.set(this.#owwCarry, 0);
    merged.set(pcm, this.#owwCarry.length);
    let offset = 0;
    while (merged.length - offset >= OWW_FRAME_SAMPLES) {
      const frame = merged.slice(offset, offset + OWW_FRAME_SAMPLES);
      offset += OWW_FRAME_SAMPLES;
      void detector
        .pushFrame(frame)
        .then((score) => this.#handleOwwScore(score))
        .catch((err: unknown) => this.#reportError(err));
    }
    this.#owwCarry = merged.slice(offset);
  }

  /**
   * Un score por frame una vez llenas las ventanas (~2.0s de audio). oww no
   * transcribe: lo unico sabido es QUE sono la palabra, asi que onWake recibe
   * la palabra sola y la peticion hablada la recoge la sesion de conversacion
   * (cli.ts la abre al recibir la palabra suelta con este motor).
   */
  #handleOwwScore(score: number | null): void {
    if (score === null || !this.#running) return;
    if (this.#held) return;
    if (Date.now() < this.#suppressedUntil) return;
    if (score < this.#owwThreshold) return;
    this.#wakeCount++;
    this.#lastWakeAt = new Date().toISOString();
    // Sin reset, las ventanas deslizantes aun contienen la palabra que acaba
    // de disparar y el mismo audio despertaria varias veces seguidas.
    this.#oww?.reset();
    this.#owwCarry = new Float32Array(0);
    this.#fireWake(this.#word);
  }

  #handleCaptureError(err: Error): void {
    this.#reportError(err);
    // Stop rather than restart: see the close handler in FfmpegMicCapture.
    void this.stop().catch((stopErr: unknown) => this.#reportError(stopErr));
  }

  #scheduleCheck(): void {
    if (!this.#running) return;
    // Nunca dos temporizadores vivos: el anterior quedaría fuera del alcance de stop().
    if (this.#timer) clearTimeout(this.#timer);
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
    const generation = this.#generation;
    try {
      if (!this.#running) return;
      if (this.#held) return;
      if (Date.now() < this.#suppressedUntil) {
        this.#suppressed++;
        return;
      }
      if (this.#ring.size === 0) return;
      if (this.#ring.rms() < ENERGY_GATE_RMS) return;
      // Consumo: la misma frase seguía en la ventana y se transcribía otra vez para nada.
      if (this.#ring.alreadySeen(ENERGY_GATE_RMS)) return;
      const window = this.#ring.snapshot();
      this.#ring.markSeen(ENERGY_GATE_RMS);

      let text: string;
      try {
        text = await this.#transcriber(window, this.#initialPrompt);
        if (generation !== this.#generation) return;
        this.#consecutiveFailures = 0;
      } catch (err) {
        // Un fallo de la sesión anterior no cuenta para la nueva.
        if (generation !== this.#generation) return;
        this.#ring.forgetSeen();
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
      if (!this.#running || generation !== this.#generation) return;
      this.#checks++;
      if (!matchesWakeWord(text, this.#word, this.#sensitivity)) {
        // Why the word did not fire is otherwise invisible: the listener stays silent and
        // the user concludes the microphone is broken. A custom wake word makes this
        // routine, because whisper has no idea "chochi" is a word and will happily
        // transcribe it as something else.
        this.#lastHeard = text;
        if (text !== this.#loggedHeard) {
          this.#loggedHeard = text;
          log.info('wake word oida', { heard: text, word: this.#word });
        }
        return;
      }

      this.#wakeCount++;
      this.#lastWakeAt = new Date().toISOString();
      // The window still holds the utterance that just fired; without clearing it
      // the next check transcribes the same audio and wakes twice per sentence.
      this.#ring.clear();
      this.#fireWake(text);
    } finally {
      // Solo el bucle de la sesión vigente se reprograma; start() ya lanzó el suyo.
      if (generation === this.#generation) this.#scheduleCheck();
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
