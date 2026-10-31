/**
 * Local speech-to-text.
 *
 * Whisper through `@huggingface/transformers` running on onnxruntime-node, i.e.
 * entirely on this machine. No cloud STT and no API key: the first run downloads
 * the model once into `paths.models` and every run after that is offline.
 */

import { log } from '../log.js';
import { paths } from '../paths.js';
import { withTimeout } from '../utils.js';
import { looksSilent } from './audio.js';
import { decodeForWhisper } from './decode.js';

export interface SttResult {
  text: string;
  language?: string;
  durationSeconds: number;
  /** Set when the audio was longer than the decode cap and only its head was read. */
  truncated?: boolean;
}

export interface Stt {
  name: string;
  transcribe(input: Buffer, opts?: { mimeType?: string }): Promise<SttResult>;
}

export interface UtteranceGapOptions {
  /** Silencio que separa dos frases. Por defecto 300 ms. */
  minSilenceMs?: number;
  /** Frecuencia del PCM de entrada. Por defecto 16 kHz. */
  sampleRate?: number;
}

/** RMS por debajo del cual un frame es silencio (-40 dBFS, igual que audio.ts). */
const UTTERANCE_SILENCE_RMS = 0.01;

/** Resolución del detector: 20 ms por frame. */
const UTTERANCE_FRAME_MS = 20;

/**
 * Parte un PCM en tramos de voz separados por silencios.
 *
 * Entrada: PCM mono con signo, 16 bits little-endian (el mismo que produce
 * `wavToPcm`/`decodeForWhisper`), sin cabecera. La salida son índices de muestra
 * con `start` inclusivo y `end` exclusivo: el tramo se corta con
 * `pcm.subarray(start * 2, end * 2)`. Los silencios cortos (menos de
 * `minSilenceMs`) se conservan dentro del tramo; los de los extremos se recortan.
 * La resolución es de un frame (20 ms), no de una muestra.
 *
 * El STT puede transcribir cada tramo por separado y unir los textos: así un
 * audio largo no pierde la cola contra el tope de whisper y una pausa larga no
 * mezcla dos peticiones en una sola transcripción. Es una función pura: no toca
 * el modelo ni el sistema de ficheros.
 */
export function splitUtteranceGaps(
  pcm: Buffer,
  opts: UtteranceGapOptions = {},
): Array<{ start: number; end: number }> {
  const sampleRate = Math.floor(opts.sampleRate ?? 16_000);
  if (sampleRate <= 0) return [];
  const totalSamples = Math.floor(pcm.length / 2);
  if (totalSamples === 0) return [];
  const minSilenceMs = Math.max(0, opts.minSilenceMs ?? 300);
  const frameSamples = Math.max(1, Math.round((sampleRate * UTTERANCE_FRAME_MS) / 1000));
  const minSilentFrames = Math.max(1, Math.ceil(minSilenceMs / UTTERANCE_FRAME_MS));
  const frames = Math.ceil(totalSamples / frameSamples);
  const ranges: Array<{ start: number; end: number }> = [];
  let startFrame = -1;
  let lastVoicedFrame = -1;
  let silentFrames = 0;

  for (let frame = 0; frame < frames; frame++) {
    const from = frame * frameSamples;
    const to = Math.min(totalSamples, from + frameSamples);
    let sum = 0;
    for (let i = from; i < to; i++) {
      const value = pcm.readInt16LE(i * 2) / 32_768;
      sum += value * value;
    }
    const voiced = to > from && Math.sqrt(sum / (to - from)) >= UTTERANCE_SILENCE_RMS;
    if (voiced) {
      if (startFrame < 0) startFrame = frame;
      lastVoicedFrame = frame;
      silentFrames = 0;
      continue;
    }
    if (startFrame < 0) continue;
    silentFrames++;
    if (silentFrames >= minSilentFrames) {
      ranges.push({
        start: startFrame * frameSamples,
        end: Math.min(totalSamples, (lastVoicedFrame + 1) * frameSamples),
      });
      startFrame = -1;
      lastVoicedFrame = -1;
      silentFrames = 0;
    }
  }

  if (startFrame >= 0 && lastVoicedFrame >= 0) {
    ranges.push({
      start: startFrame * frameSamples,
      end: Math.min(totalSamples, (lastVoicedFrame + 1) * frameSamples),
    });
  }
  return ranges;
}

/**
 * `onnx-community/whisper-base`, quantised.
 *
 * base rather than `Xenova/whisper-tiny`: tiny drops words at normal speaking
 * rate, and a misheard instruction gets acted on, so accuracy wins over speed
 * here. `small` is the next step up and is roughly 3x base's CPU time again,
 * which stops being a voice feature and starts being a stall. Verified on this
 * machine: base loads from a cold cache in ~11s and transcribes ~3s of Spanish
 * audio in ~2s on CPU with `dtype: 'q8'`.
 *
 * Must stay multilingual: the `whisper-*.en` checkpoints cannot do Spanish at all
 * and the pipeline returns English-shaped noise rather than failing loudly.
 */
const DEFAULT_MODEL = 'onnx-community/whisper-base';

/**
 * First-run budget. The model download plus session creation on a cold cache is
 * minutes, not seconds; a shorter ceiling would kill the only load the user
 * actually experiences. Subsequent loads are seconds because the cache is warm.
 */
const LOAD_TIMEOUT_MS = 10 * 60_000;

/** Per-note inference budget. Measured at roughly 0.7x real time on CPU. */
const TRANSCRIBE_TIMEOUT_MS = 5 * 60_000;

/** The pipeline type, kept structural so the heavy import stays inside a function. */
type AsrPipeline = (
  audio: Float32Array,
  options: { language: string; task: string; chunk_length_s: number; stride_length_s: number },
) => Promise<{ text: string }>;

let inflight: Promise<AsrPipeline> | null = null;

/**
 * The pipeline, memoised process-wide.
 *
 * The promise itself is the memo: concurrent callers all await the same object,
 * so two voice notes arriving back to back cannot start two downloads or two ONNX
 * sessions. Telegram delivers messages in bursts, and a plain `let pipe` guard
 * would leak a second session for exactly that pattern.
 */
function loadPipeline(model: string): Promise<AsrPipeline> {
  inflight ??= (async () => {
    const { LogLevel, env, pipeline } = await import('@huggingface/transformers');
    // Not the library default (`node_modules/@Users/.../.cache` under the repo):
    // a wiped state dir must not leave a whisper model behind, and a model
    // downloaded into the repo would be committed with it.
    env.cacheDir = paths.models;
    env.logLevel = LogLevel.ERROR;

    const pipe = await withTimeout(
      pipeline('automatic-speech-recognition', model, { dtype: 'q8', device: 'cpu' }),
      LOAD_TIMEOUT_MS,
      `whisper model ${model} did not finish loading within ${LOAD_TIMEOUT_MS / 1000}s`,
    );
    log.info('stt model ready', { model });
    return pipe as unknown as AsrPipeline;
  })().catch((err: unknown) => {
    // Clear the memo so a later attempt can retry: a download killed by a flaky
    // connection must not leave the process permanently unable to transcribe.
    inflight = null;
    throw err;
  });
  return inflight;
}

/**
 * 30s window with 5s of overlap.
 *
 * Whisper's positional embedding only covers 30s, so anything longer has to be
 * chunked or the tail is silently dropped. The overlap is what stops a word
 * straddling a boundary from being transcribed as two fragments.
 */
const CHUNK_SECONDS = 30;
const STRIDE_SECONDS = 5;

export function createLocalWhisperStt(opts: { model?: string } = {}): Stt {
  const model = opts.model ?? DEFAULT_MODEL;

  return {
    name: `whisper:${model}`,
    async transcribe(
      input: Buffer,
      transcribeOpts: { mimeType?: string } = {},
    ): Promise<SttResult> {
      // Whisper takes float PCM here, not a container. Voice notes are ogg/opus
      // and decode in-process; anything else (Telegram sends `audio/mpeg` for
      // regular audio uploads) goes through the bundled ffmpeg, which sniffs the
      // real format from the bytes — including a wrong or missing mime, which
      // tries opus first and falls to ffmpeg only after opus fails. What never
      // happens is feeding mp3 bytes to the opus decoder and keeping the output:
      // that produces a garbled transcript that looks like a working feature.
      const decoded = await decodeForWhisper(input, transcribeOpts.mimeType);
      const { samples, sampleRate } = decoded;
      if (looksSilent(samples)) {
        // Refused here rather than transcribed: an empty note sent to whisper
        // reliably returns a hallucinated sentence, and a hallucinated
        // instruction is worse than no reply at all.
        throw new Error('la nota de voz está vacía o en silencio');
      }

      const pipe = await loadPipeline(model);
      const output = await withTimeout(
        pipe(samples, {
          // Forced rather than auto-detected. Whisper's detector is unreliable on
          // the short clips that dominate voice notes, and a wrong guess does not
          // degrade gracefully: it switches the decoder to translation, so an
          // English note comes back as Spanish instead of as itself. Cost of
          // forcing it is that an English note is transcribed with a Spanish
          // decoder, which is still better than translating it.
          language: 'spanish',
          task: 'transcribe',
          chunk_length_s: CHUNK_SECONDS,
          stride_length_s: STRIDE_SECONDS,
        }),
        TRANSCRIBE_TIMEOUT_MS,
        `whisper did not finish transcribing within ${TRANSCRIBE_TIMEOUT_MS / 1000}s`,
      );

      const text = output.text.trim();
      return {
        text,
        language: 'spanish',
        durationSeconds: Math.round((samples.length / sampleRate) * 100) / 100,
        truncated: decoded.capped || undefined,
      };
    },
  };
}

/** Error with a message worth showing to the user rather than a stack trace. */
/** Fallo de red al bajar el modelo (Node fetch o la descarga del hub de modelos). */
const OFFLINE_DOWNLOAD =
  /\b(?:fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|getaddrinfo)\b|Could not locate file|huggingface\.co/i;

export class SttError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SttError';
  }
}

/**
 * Transcribe a voice note with the local model, reporting failures in Spanish.
 *
 * The friendly wrapper exists because every failure mode here is user-triggered
 * (a truncated download, a note too short, a model that will not fit in memory)
 * and the raw messages are English stack traces from deep inside onnxruntime.
 */
export async function transcribeVoiceNote(
  input: Buffer,
  opts: { mimeType?: string } = {},
): Promise<SttResult> {
  if (input.length === 0) throw new SttError('la nota de voz llegó vacía');

  try {
    return await createLocalWhisperStt().transcribe(input, opts);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn('stt failed', { error: detail });
    // Matched on message text rather than error classes: the underlying throws
    // come from three unrelated libraries (opus decoder, onnxruntime, fetch), so
    // this is the only shape they share.
    if (detail.includes('silencio')) throw new SttError('la nota de voz está vacía o en silencio');
    if (detail.includes('no opus frames')) {
      throw new SttError('no pude entender el audio recibido (no es un ogg/opus válido)');
    }
    if (detail.includes('no pude leer ese audio') || detail.includes('pista de sonido')) {
      throw new SttError(
        'no pude leer ese audio; prueba a mandarlo como nota de voz o en mp3, m4a o wav',
      );
    }
    if (detail.includes('ffmpeg no esta disponible')) {
      throw new SttError(
        'no pude leer ese audio: falta ffmpeg en esta instalación; prueba a mandarlo como nota de voz',
      );
    }
    if (detail.includes('whisper model')) {
      throw new SttError(
        'el modelo de voz no se pudo cargar. La primera vez necesita internet; revisa la conexión y vuelve a intentarlo',
      );
    }
    // Sin internet la primera vez no se puede bajar el modelo: el error crudo
    // («fetch failed», «Could not locate file: https://…») acababa en «error interno».
    if (OFFLINE_DOWNLOAD.test(detail)) {
      throw new SttError(
        'la primera nota de voz necesita internet para descargar el modelo de voz (solo una vez). Conéctate y vuelve a mandarla',
      );
    }
    // El detalle técnico ya está en el registro; al chat solo va la frase.
    throw new SttError('no pude transcribir la nota de voz. Prueba otra vez en un momento');
  }
}
