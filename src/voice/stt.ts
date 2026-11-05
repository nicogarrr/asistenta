/**
 * Local speech-to-text.
 *
 * Whisper through `@huggingface/transformers` running on onnxruntime-node, i.e.
 * entirely on this machine. No cloud STT and no API key: the first run downloads
 * the model once into `paths.models` and every run after that is offline.
 */

import { existsSync } from 'node:fs';
import { totalmem } from 'node:os';
import { join } from 'node:path';
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
  /** Aviso para el dueño (una vez): se está bajando el modelo grande. */
  notice?: string;
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
 * `onnx-community/whisper-small`, quantised: el respaldo de las notas de voz y el
 * modelo de la palabra de activación (wake.ts), que necesita una pasada rápida cada
 * segundo y medio.
 *
 * small en vez de base desde el 2-nov-2026: «pon en YouTube Bailando de Enrique
 * Iglesias» dicho por Nico salía «ponen tu tuf en el ordenador bailando de
 * entrecigulos». Con 74 notas de prueba (órdenes sintéticas en 3 voces castellanas,
 * con y sin ruido, más 2 notas reales suyas) small + pista + margen de silencio baja
 * el WER de ~34 % a ~8 %.
 *
 * Must stay multilingual: the `whisper-*.en` checkpoints cannot do Spanish at all
 * and the pipeline returns English-shaped noise rather than failing loudly.
 */
export const SMALL_STT_MODEL = 'onnx-community/whisper-small';

/**
 * `onnx-community/whisper-large-v3-turbo` (MIT), quantised: el modelo de las notas de
 * voz por defecto desde el 2-nov-2026 (Nico: el mejor modelo libre, «me da igual lo
 * que pese»). Medido con las mismas 74 notas: con la voz real de Nico es el único que
 * oye «Enrique Iglesias» (WER 12,5 % frente a 33 % de small y 17 % de medium); una
 * nota de 4-9 s tarda unos 2,5-3,5 s con 4 núcleos de CPU (small ~1-2 s; medium el
 * doble que turbo y 6,6 GB). Pesa 1,1 GB de descarga (una vez) y ~3 GB de RAM.
 */
export const TURBO_STT_MODEL = 'onnx-community/whisper-large-v3-turbo';

export const DEFAULT_STT_MODEL = TURBO_STT_MODEL;

/** Con menos RAM total que esto, el modelo grande no compensa: small. */
export const TURBO_MIN_RAM_BYTES = 8 * 1024 ** 3;

/**
 * El modelo de las notas de voz: `PA_STT_MODEL=turbo|small` manda; sin elegir, turbo
 * salvo en un PC con poca RAM.
 */
export function sttModelFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  totalMem: number = totalmem(),
): string {
  const raw = (env.PA_STT_MODEL ?? '').trim().toLowerCase();
  if (raw === 'small') return SMALL_STT_MODEL;
  if (raw === 'turbo') return TURBO_STT_MODEL;
  if (raw) log.warn('PA_STT_MODEL desconocido; uso el de por defecto', { value: raw });
  return totalMem < TURBO_MIN_RAM_BYTES ? SMALL_STT_MODEL : TURBO_STT_MODEL;
}

/** El modelo (q8) ya está en la carpeta de modelos: cargarlo no necesita internet. */
export function whisperCached(model: string, root: string = paths.models): boolean {
  const dir = join(root, ...model.split('/'));
  return (
    existsSync(join(dir, 'config.json')) &&
    existsSync(join(dir, 'onnx', 'encoder_model_quantized.onnx')) &&
    existsSync(join(dir, 'onnx', 'decoder_model_merged_quantized.onnx'))
  );
}

/**
 * Pista para whisper (el «initial prompt»): vocabulario de las órdenes de todos los
 * días. Sin ella, «YouTube» dicho en castellano sale «yo tuve» o «Dios tuve» y
 * «pon en» sale «ponen». Es una lista de nombres y no frases: con frases enteras
 * («Busca en Google.») whisper llegó a devolver la frase de la pista en lugar del
 * audio. Los nombres propios de canciones y artistas los pone la persona; aquí solo
 * va lo general (apps, mandos, habitaciones).
 */
export const STT_PROMPT =
  'Pon en YouTube una canción. Abre Netflix, Spotify, Disney+, Prime Video o HBO Max en la tele del salón o del dormitorio. Busca en Google.';

/** Silencio que se añade delante y detrás: sin él whisper se come la primera palabra. */
export const EDGE_PAD_SECONDS = 0.5;

/** Hasta aquí cabe en una sola ventana de whisper (30 s) con el margen de silencio. */
const PROMPTED_MAX_SECONDS = 28;

/**
 * First-run budget. The model download plus session creation on a cold cache is
 * minutes, not seconds; a shorter ceiling would kill the only load the user
 * actually experiences. Subsequent loads are seconds because the cache is warm.
 */
const LOAD_TIMEOUT_MS = 10 * 60_000;

/** Per-note inference budget. Measured at roughly 0.7x real time on CPU. */
const TRANSCRIBE_TIMEOUT_MS = 5 * 60_000;

/** The pipeline type, kept structural so the heavy import stays inside a function. */
/** Los logits de un paso de decodificación (un Tensor de transformers.js, lote de 1). */
type LogitsLike = { data: ArrayLike<number> & Iterable<number> };

export type AsrPipeline = ((
  audio: Float32Array,
  options: { language: string; task: string; chunk_length_s: number; stride_length_s: number },
) => Promise<{ text: string }>) & {
  processor: (audio: Float32Array) => Promise<{ input_features: unknown }>;
  tokenizer: {
    convert_tokens_to_ids: (token: string) => number;
    encode: (text: string, opts?: { add_special_tokens?: boolean }) => number[];
    decode: (ids: number[], opts?: { skip_special_tokens?: boolean }) => string;
  };
  model: {
    generate: (args: {
      inputs: unknown;
      decoder_input_ids: number[];
      max_new_tokens: number;
      logits_processor?: Array<(ids: unknown, logits: LogitsLike) => LogitsLike>;
    }) => Promise<{ tolist: () => Array<Array<number | bigint>> }>;
  };
};

const inflight = new Map<string, Promise<AsrPipeline>>();

type TransformersModule = typeof import('@huggingface/transformers');

/**
 * El import real de transformers.js, indirección para los tests: `vi.mock`
 * sobre un `import()` dinámico se salta el mock de forma intermitente (una de
 * cada varias ejecuciones cargaba el whisper de verdad, descarga de 100 MB y
 * todo, y el test fracasaba con la alucinación del modelo sobre el tono de
 * prueba). Con el cargador inyectado el test es determinista.
 */
let importTransformers: () => Promise<TransformersModule> = () =>
  import('@huggingface/transformers');

/** Solo para tests: sustituye el import dinámico de transformers (null lo devuelve al real). */
export function setImportTransformersForTests(
  loader: (() => Promise<TransformersModule>) | null,
): void {
  importTransformers = loader ?? (() => import('@huggingface/transformers'));
}

/**
 * The pipeline, memoised process-wide (one per checkpoint).
 *
 * The promise itself is the memo: concurrent callers all await the same object,
 * so two voice notes arriving back to back cannot start two downloads or two ONNX
 * sessions. Telegram delivers messages in bursts, and a plain `let pipe` guard
 * would leak a second session for exactly that pattern. La palabra de activación
 * (wake.ts) usa este mismo memo: con las dos encendidas whisper-small se carga una
 * sola vez, no dos.
 */
export function loadWhisperPipeline(model: string): Promise<AsrPipeline> {
  const memo = inflight.get(model);
  if (memo) return memo;
  const loading = (async () => {
    const { LogLevel, env, pipeline } = await importTransformers();
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
    inflight.delete(model);
    throw err;
  });
  inflight.set(model, loading);
  return loading;
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

/** El PCM con `seconds` de silencio delante y detrás (whisper se come la primera palabra si la voz empieza en la muestra 0). */
export function padWithSilence(
  samples: Float32Array,
  sampleRate: number,
  seconds: number,
): Float32Array {
  const pad = Math.max(0, Math.round(sampleRate * seconds));
  if (pad === 0) return samples;
  const out = new Float32Array(samples.length + 2 * pad);
  out.set(samples, pad);
  return out;
}

/** Palabras en minúscula, sin tildes ni puntuación, para comparar textos de whisper. */
function plainWords(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9ñ+]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * Whisper enganchado: la misma palabra o el mismo grupo de hasta 6 palabras cuatro
 * veces seguidas («de la tele de la tele de la tele de la tele»). Una frase normal
 * repite como mucho dos («sí, sí»).
 */
export function looksLikeWhisperLoop(text: string): boolean {
  const w = plainWords(text);
  for (let n = 1; n <= 6; n++) {
    for (let start = 0; start + 4 * n <= w.length; start++) {
      let reps = 1;
      while (start + (reps + 1) * n <= w.length) {
        let same = true;
        for (let k = 0; k < n; k++) {
          if (w[start + k] !== w[start + reps * n + k]) {
            same = false;
            break;
          }
        }
        if (!same) break;
        reps++;
      }
      if (reps >= 4) return true;
    }
  }
  return false;
}

/** El texto es un trozo de la pista (3 palabras o más): whisper la ha copiado en vez de oír. */
function copiesPrompt(text: string): boolean {
  const w = plainWords(text);
  if (w.length < 3) return false;
  const p = plainWords(STT_PROMPT);
  for (let i = 0; i + w.length <= p.length; i++) {
    if (w.every((word, k) => p[i + k] === word)) return true;
  }
  return false;
}

/**
 * Una ventana (hasta 30 s) en castellano, con la pista delante si se pide, como el
 * `initial_prompt` de whisper:
 * `<|startofprev|> pista <|startoftranscript|><|es|><|transcribe|><|notimestamps|>`.
 * El pipeline de transformers.js no tiene esa opción (un `initial_prompt` se ignora
 * sin avisar), así que se llama al modelo directamente y se quita el prefijo de la
 * salida antes de decodificar. Devuelve también la confianza media del modelo (log-prob
 * por token): es lo que whisper usa para decidir si repetir una transcripción.
 */
async function transcribeWindow(
  pipe: AsrPipeline,
  features: unknown,
  seconds: number,
  prompt: string | null,
): Promise<{ text: string; avgLogprob: number }> {
  const tok = pipe.tokenizer;
  const id = (t: string) => tok.convert_tokens_to_ids(t);
  // Whisper admite 448 tokens de decodificador; la pista va en la mitad como mucho.
  const promptIds = prompt
    ? [
        id('<|startofprev|>'),
        ...tok.encode(` ${prompt}`, { add_special_tokens: false }).slice(-200),
      ]
    : [];
  const prefix = [
    ...promptIds,
    id('<|startoftranscript|>'),
    id('<|es|>'),
    id('<|transcribe|>'),
    id('<|notimestamps|>'),
  ];
  // Log-prob del token elegido en cada paso (decodificación voraz: el máximo).
  const logprobs: number[] = [];
  const confidence = (_ids: unknown, logits: LogitsLike): LogitsLike => {
    const d = logits.data;
    let max = Number.NEGATIVE_INFINITY;
    for (const v of d) if (v > max) max = v;
    let sum = 0;
    for (const v of d) sum += Math.exp(v - max);
    logprobs.push(-Math.log(sum));
    return logits;
  };
  // Unos 8 tokens por segundo de voz y margen: una nota de 2 s no puede volver como
  // un párrafo aunque whisper se enganche.
  const maxNew = Math.min(440 - prefix.length, Math.ceil(seconds * 8) + 24);
  const out = await pipe.model.generate({
    inputs: features,
    decoder_input_ids: prefix,
    max_new_tokens: maxNew,
    logits_processor: [confidence],
  });
  // Las marcas de tiempo (<|1.00|>…) van después de <|notimestamps|> en el vocabulario y
  // `skip_special_tokens` no las quita: fuera antes de decodificar.
  const lastSpecial = id('<|notimestamps|>');
  const seq = (out.tolist()[0] ?? [])
    .map(Number)
    .slice(prefix.length)
    .filter((t) => lastSpecial < 0 || t < lastSpecial);
  const avgLogprob = logprobs.length
    ? logprobs.reduce((a, b) => a + b, 0) / logprobs.length
    : Number.NEGATIVE_INFINITY;
  return { text: tok.decode(seq, { skip_special_tokens: true }).trim(), avgLogprob };
}

/** Por debajo de esta confianza media la versión con pista se contrasta con otra sin pista. */
const PROMPT_MIN_LOGPROB = -0.3;
/** Ventaja que se da a la versión con pista al comparar las dos. */
const PROMPT_BIAS = 0.05;

/**
 * Una nota corta (una ventana): primero con la pista; si sale un bucle, una copia de
 * la pista o el modelo duda (confianza media baja: «in», «like and subscribe» sobre una
 * orden en castellano), se transcribe también sin pista y gana la versión de la que el
 * modelo está más seguro. Medido con 74 notas: la segunda pasada hace falta en ~1 de 4.
 */
async function transcribeShort(
  pipe: AsrPipeline,
  padded: Float32Array,
  seconds: number,
): Promise<string> {
  const { input_features } = await pipe.processor(padded);
  const withPrompt = await transcribeWindow(pipe, input_features, seconds, STT_PROMPT);
  const broken =
    !withPrompt.text || looksLikeWhisperLoop(withPrompt.text) || copiesPrompt(withPrompt.text);
  if (!broken && withPrompt.avgLogprob >= PROMPT_MIN_LOGPROB) return withPrompt.text;
  const plain = await transcribeWindow(pipe, input_features, seconds, null);
  const usePlain = broken || plain.avgLogprob > withPrompt.avgLogprob + PROMPT_BIAS;
  log.info('stt second pass', {
    broken,
    prompted: Math.round(withPrompt.avgLogprob * 100) / 100,
    plain: Math.round(plain.avgLogprob * 100) / 100,
    chose: usePlain ? 'plain' : 'prompt',
  });
  return usePlain ? plain.text : withPrompt.text;
}

export function createLocalWhisperStt(opts: { model?: string } = {}): Stt {
  const model = opts.model ?? SMALL_STT_MODEL;

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

      const pipe = await loadWhisperPipeline(model);
      const padded = padWithSilence(samples, sampleRate, EDGE_PAD_SECONDS);
      const seconds = samples.length / sampleRate;
      let text: string;
      if (seconds <= PROMPTED_MAX_SECONDS) {
        text = await withTimeout(
          transcribeShort(pipe, padded, seconds),
          TRANSCRIBE_TIMEOUT_MS,
          `whisper did not finish transcribing within ${TRANSCRIBE_TIMEOUT_MS / 1000}s`,
        );
      } else {
        const output = await withTimeout(
          pipe(padded, {
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
        text = output.text;
      }

      return {
        text: text.trim(),
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

/** Modelos ya cargados en memoria en este proceso. */
const readyModels = new Set<string>();
/** Última descarga del modelo grande que falló: no se reintenta antes de 10 min. */
let bigFailedAt = 0;
const BIG_RETRY_MS = 10 * 60_000;
/** El aviso de descarga se da una vez por proceso. */
let downloadNoticeGiven = false;

export const STT_DOWNLOAD_NOTICE =
  'Descargando el modelo de voz grande (1,1 GB, solo esta vez). Mientras tanto, tus audios van con el pequeño.';

export interface SttDeps {
  env?: NodeJS.ProcessEnv;
  totalMem?: number;
  isCached?: (model: string) => boolean;
  now?: () => number;
}

/**
 * Consumo: el modelo grande de las notas de voz (turbo, ~3 GB de RAM) se quedaba en memoria
 * para siempre tras la primera nota. Tras este rato sin notas se descarga; la siguiente nota
 * lo vuelve a cargar del disco (unos segundos, sin descargar nada). whisper-small no se toca
 * nunca: lo usa la palabra de activación, que tiene que contestar al momento.
 */
export const BIG_MODEL_IDLE_MS = 10 * 60_000;
let notesBusy = 0;
let lastNoteAt = 0;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;

/** Descarga de la RAM los modelos de notas (no small) si no hay notas en curso ni recientes. */
export async function releaseIdleWhisper(
  now: number = Date.now(),
  idleMs: number = BIG_MODEL_IDLE_MS,
): Promise<string[]> {
  if (notesBusy > 0 || now - lastNoteAt < idleMs) return [];
  const released: string[] = [];
  for (const [model, memo] of [...inflight]) {
    if (model === SMALL_STT_MODEL) continue;
    inflight.delete(model);
    released.push(model);
    try {
      const pipe = (await memo) as unknown as { dispose?: () => Promise<unknown> };
      await pipe.dispose?.();
    } catch {
      // Una carga que falló ya no ocupa nada; una que no se deja liberar la recoge el GC.
    }
    log.info('stt big model released after idle', {
      model,
      idleMin: Math.round(idleMs / 60_000),
    });
  }
  return released;
}

function scheduleRelease(): void {
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => {
    releaseTimer = null;
    void releaseIdleWhisper().catch(() => undefined);
  }, BIG_MODEL_IDLE_MS + 1_000);
  releaseTimer.unref?.();
}

/** Solo para tests: vuelve al estado de un proceso recién arrancado. */
export function resetSttStateForTests(): void {
  readyModels.clear();
  inflight.clear();
  notesBusy = 0;
  lastNoteAt = 0;
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = null;
  bigFailedAt = 0;
  downloadNoticeGiven = false;
}

/**
 * Qué modelo transcribe esta nota. El grande solo si ya está en el disco o en
 * memoria: si falta, se baja en segundo plano y esta nota va con small, para que la
 * primera nota no espere minutos a una descarga de 1,1 GB.
 */
function pickModel(deps: SttDeps): { model: string; notice?: string } {
  const preferred = sttModelFromEnv(deps.env ?? process.env, deps.totalMem ?? totalmem());
  if (preferred === SMALL_STT_MODEL || readyModels.has(preferred)) return { model: preferred };
  const now = (deps.now ?? Date.now)();
  const recentlyFailed = now - bigFailedAt < BIG_RETRY_MS;
  const cached = (deps.isCached ?? whisperCached)(preferred);
  if (cached && !recentlyFailed) return { model: preferred };
  if (cached) return { model: SMALL_STT_MODEL };
  if (!inflight.has(preferred) && !recentlyFailed) {
    log.info('stt big model download start', { model: preferred });
    loadWhisperPipeline(preferred)
      .then(() => {
        readyModels.add(preferred);
        log.info('stt big model ready', { model: preferred });
        lastNoteAt = (deps.now ?? Date.now)();
        scheduleRelease();
      })
      .catch((err: unknown) => {
        bigFailedAt = (deps.now ?? Date.now)();
        log.warn('stt big model download failed; small stays', { error: String(err) });
      });
  }
  if (downloadNoticeGiven) return { model: SMALL_STT_MODEL };
  downloadNoticeGiven = true;
  return { model: SMALL_STT_MODEL, notice: STT_DOWNLOAD_NOTICE };
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
  deps: SttDeps = {},
): Promise<SttResult> {
  notesBusy++;
  try {
    return await transcribeVoiceNoteNow(input, opts, deps);
  } finally {
    notesBusy--;
    lastNoteAt = (deps.now ?? Date.now)();
    scheduleRelease();
  }
}

async function transcribeVoiceNoteNow(
  input: Buffer,
  opts: { mimeType?: string },
  deps: SttDeps,
): Promise<SttResult> {
  if (input.length === 0) throw new SttError('la nota de voz llegó vacía');

  let { model, notice } = pickModel(deps);
  try {
    if (model !== SMALL_STT_MODEL) {
      try {
        await loadWhisperPipeline(model);
      } catch (err) {
        // El grande no carga (archivo a medias, sin memoria…): esta nota va con small y
        // no se vuelve a intentar hasta dentro de un rato.
        log.warn('stt big model failed; using small', { error: String(err) });
        bigFailedAt = (deps.now ?? Date.now)();
        model = SMALL_STT_MODEL;
      }
    }
    const result = await createLocalWhisperStt({ model }).transcribe(input, opts);
    readyModels.add(model);
    return notice ? { ...result, notice } : result;
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
