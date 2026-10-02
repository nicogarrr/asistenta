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
import { decodeOggOpusToPcm, looksSilent } from './audio.js';

export interface SttResult {
  text: string;
  language?: string;
  durationSeconds: number;
}

export interface Stt {
  name: string;
  transcribe(input: Buffer, opts?: { mimeType?: string }): Promise<SttResult>;
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
      // Only the mime types that can actually be decoded are attempted. Whisper
      // takes float PCM here, not a container, so there is no mp3/wav decoder in
      // this process: Telegram does send `audio/mpeg` for regular audio uploads,
      // and silently decoding those bytes as opus produces a garbled transcript
      // that looks like a working feature. A missing or generic mime type falls
      // through to the decoder, which reports properly if it is not opus.
      const mime = transcribeOpts.mimeType?.toLowerCase() ?? '';
      if (mime && !mime.includes('ogg') && !mime.includes('opus')) {
        throw new Error(`unsupported audio type ${mime}: solo se transcriben notas ogg/opus`);
      }

      const { samples, sampleRate } = await decodeOggOpusToPcm(input);
      if (looksSilent(samples)) {
        // Refused here rather than transcribed: an empty note sent to whisper
        // reliably returns a hallucinated sentence, and a hallucinated
        // instruction is worse than no reply at all.
        throw new Error('la nota de voz esta vacia o en silencio');
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
      };
    },
  };
}

/** Error with a message worth showing to the user rather than a stack trace. */
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
  if (input.length === 0) throw new SttError('la nota de voz llego vacia');

  try {
    return await createLocalWhisperStt().transcribe(input, opts);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn('stt failed', { error: detail });
    // Matched on message text rather than error classes: the underlying throws
    // come from three unrelated libraries (opus decoder, onnxruntime, fetch), so
    // this is the only shape they share.
    if (detail.includes('silencio')) throw new SttError('la nota de voz esta vacia o en silencio');
    if (detail.includes('no opus frames')) {
      throw new SttError('no pude entender el audio recibido (no es un ogg/opus valido)');
    }
    if (detail.includes('unsupported audio type')) {
      throw new SttError('solo puedo transcribir notas de voz ogg/opus, no ese formato');
    }
    if (detail.includes('whisper model')) {
      throw new SttError(
        'el modelo de voz no se pudo cargar. Revisa la conexion la primera vez y vuelve a intentarlo',
      );
    }
    throw new SttError(`no pude transcribir la nota de voz: ${detail}`);
  }
}
