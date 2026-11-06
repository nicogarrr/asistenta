/**
 * Voz local neuronal con sherpa-onnx (https://github.com/k2-fsa/sherpa-onnx, Apache-2.0)
 * dentro del propio proceso: el modelo se carga una vez y cada frase tarda ~0,1 s
 * en empezar, en vez de lanzar un programa y recargar el modelo en cada frase como
 * Piper. Va detrás de la misma interfaz `Tts` que SAPI y Piper.
 *
 * El módulo nativo se carga perezosamente en la primera frase: si falta o no carga
 * en este PC, `speak` falla y quien lo envuelve (voz-local.ts) habla con la voz de
 * siempre.
 */

import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { log } from '../log.js';
import { pcmToWavPcm16 } from './audio.js';
import {
  encodeSpeech,
  type Tts,
  type TtsAudio,
  type TtsSpeakOptions,
  truncateForSpeech,
} from './tts.js';

/** Lo mínimo de sherpa-onnx-node que se usa aquí (el paquete no trae tipos). */
export interface SherpaAudio {
  samples: Float32Array;
  sampleRate: number;
}

export interface SherpaMotor {
  generateAsync(req: {
    text: string;
    sid: number;
    speed: number;
    /** Supertonic: idioma y pasos van aquí (API nueva de sherpa-onnx-node). */
    generationConfig?: {
      sid: number;
      speed: number;
      numSteps: number;
      extra: Record<string, string>;
    };
    onProgress?: (info: { samples: Float32Array; progress: number }) => number;
  }): Promise<SherpaAudio>;
}

export interface SherpaModulo {
  OfflineTts: { createAsync(config: unknown): Promise<SherpaMotor> };
}

export type CargarSherpa = () => SherpaModulo;

/**
 * En Windows sherpa-onnx (onnxruntime 1.28) y whisper (onnxruntime-node 1.30) traen cada uno
 * su `onnxruntime.dll`, y Windows usa para los dos la que se cargó primero. Si la voz se carga
 * antes (al abrir /voz se precargan las dos a la vez), whisper se queda con la 1.28, que no
 * tiene la API que pide, y cada nota falla. La 1.30 sí sirve a sherpa (la API de onnxruntime
 * solo crece), así que en Windows se carga onnxruntime-node antes que sherpa.
 */
export function cargarSherpaCon(
  requerir: (id: string) => unknown,
  plataforma: NodeJS.Platform = process.platform,
): SherpaModulo {
  cargarOrt(requerir, plataforma);
  try {
    return requerir('sherpa-onnx-node') as SherpaModulo;
  } catch (error) {
    throw new Error(
      `No pude cargar la voz local (sherpa-onnx-node: ${mensajeCorto(error)}). Ejecuta «npm ci» en la carpeta de Asistenta y reiníciala; mientras, hablo con la voz de Windows.`,
    );
  }
}

/** Resultado de cargar onnxruntime-node antes que nada (solo Windows). */
export interface PrecargaOrt {
  ok: boolean;
  /** Qué pasa y cómo arreglarlo, en castellano, si no cargó. */
  error?: string;
}

function mensajeCorto(error: unknown): string {
  const m = error instanceof Error ? error.message : String(error);
  return m.split('\n')[0]?.slice(0, 160) ?? '';
}

function cargarOrt(requerir: (id: string) => unknown, plataforma: NodeJS.Platform): PrecargaOrt {
  if (plataforma !== 'win32') return { ok: true };
  try {
    requerir('onnxruntime-node');
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: `No pude cargar onnxruntime-node (${mensajeCorto(error)}): no entenderé las notas de voz. Ejecuta «npm ci» en la carpeta de Asistenta y reiníciala.`,
    };
  }
}

let precarga: PrecargaOrt | null = null;

/**
 * Al arrancar, en Windows: carga onnxruntime-node (1.30) antes que cualquier otra cosa, para
 * que su `onnxruntime.dll` sea la del proceso pase lo que pase después (sherpa, whisper,
 * memoria semántica, palabra de activación). Sin esto el orden dependía de qué se usaba
 * primero. Una sola vez; si falla, lo dice claro en el log en vez de callarlo.
 */
export function precargarOnnxRuntime(
  requerir: (id: string) => unknown = createRequire(import.meta.url),
  plataforma: NodeJS.Platform = process.platform,
  avisar: (texto: string) => void = (t) => log.warn(t),
): PrecargaOrt {
  if (precarga) return precarga;
  precarga = cargarOrt(requerir, plataforma);
  if (precarga.error) avisar(precarga.error);
  return precarga;
}

/** Solo para tests. */
export function olvidarPrecargaOrt(): void {
  precarga = null;
}

const cargarPorDefecto: CargarSherpa = () => cargarSherpaCon(createRequire(import.meta.url));

/** Rutas de un modelo VITS/Piper ya descargado y comprobado. */
export interface ModeloSherpa {
  onnx: string;
  tokens: string;
  /** Carpeta espeak-ng-data que trae el propio archivo del modelo. */
  datos: string;
  /** Solo Kokoro: tabla de voces, léxicos y diccionario que trae su archivo. */
  kokoro?: { voces: string; lexicon: string; dict: string };
  /** Solo Supertonic 3: sus cuatro onnx, su config, su índice de letras y sus voces. */
  supertonic?: {
    durationPredictor: string;
    textEncoder: string;
    vectorEstimator: string;
    vocoder: string;
    ttsJson: string;
    unicodeIndexer: string;
    voiceStyle: string;
  };
}

/** Pasos de Supertonic: 8 es su valor por defecto (con 2-5 suena áspera). */
export const SUPERTONIC_PASOS = 8;

export interface SherpaOptions {
  modelo: ModeloSherpa;
  cargar?: CargarSherpa;
  /** Hablante dentro del modelo (los de un solo hablante usan 0). */
  sid?: number;
  /** Hilos de cálculo; por defecto hasta 4 dejando un núcleo libre. */
  hilos?: number;
}

function cancelada(): Error {
  const err = new Error('la sintesis de voz se cancelo');
  err.name = 'AbortError';
  return err;
}

export function createSherpaTts(opts: SherpaOptions): Tts {
  const cargar = opts.cargar ?? cargarPorDefecto;
  const hilos = opts.hilos ?? Math.max(1, Math.min(4, availableParallelism() - 1));
  let motor: Promise<SherpaMotor> | null = null;
  const obtener = (): Promise<SherpaMotor> => {
    if (!motor) {
      const nuevo = Promise.resolve().then(() =>
        cargar().OfflineTts.createAsync({
          model: {
            ...(opts.modelo.supertonic
              ? { supertonic: { ...opts.modelo.supertonic } }
              : opts.modelo.kokoro
                ? {
                    kokoro: {
                      model: opts.modelo.onnx,
                      voices: opts.modelo.kokoro.voces,
                      tokens: opts.modelo.tokens,
                      dataDir: opts.modelo.datos,
                      lexicon: opts.modelo.kokoro.lexicon,
                      dictDir: opts.modelo.kokoro.dict,
                      // Fonemas castellanos de espeak-ng (con «z» y «c» de España).
                      lang: 'es',
                    },
                  }
                : {
                    vits: {
                      model: opts.modelo.onnx,
                      tokens: opts.modelo.tokens,
                      dataDir: opts.modelo.datos,
                    },
                  }),
            numThreads: hilos,
            provider: 'cpu',
            debug: 0,
          },
          maxNumSentences: 1,
        }),
      );
      // Un fallo de carga no se queda memorizado: la siguiente frase lo reintenta.
      nuevo.catch(() => {
        if (motor === nuevo) motor = null;
      });
      motor = nuevo;
    }
    return motor;
  };
  return {
    name: 'sherpa',
    async speak(text: string, speakOpts: TtsSpeakOptions = {}): Promise<TtsAudio> {
      const trimmed = text.trim();
      if (!trimmed) throw new Error('no hay texto que decir');
      const signal = speakOpts.signal;
      if (signal?.aborted) throw cancelada();
      const spoken = truncateForSpeech(trimmed);
      try {
        const tts = await obtener();
        if (signal?.aborted) throw cancelada();
        const sid = opts.sid ?? 0;
        const audio = await tts.generateAsync({
          text: spoken.replace(/\s+/g, ' '),
          sid,
          speed: 1,
          // Supertonic lee varios idiomas: sin «es» no lo dice en castellano.
          ...(opts.modelo.supertonic
            ? {
                generationConfig: {
                  sid,
                  speed: 1.05,
                  numSteps: SUPERTONIC_PASOS,
                  extra: { lang: 'es' },
                },
              }
            : {}),
          // Devolver 0 corta la síntesis en curso al cancelar.
          onProgress: () => (signal?.aborted ? 0 : 1),
        });
        if (signal?.aborted) throw cancelada();
        if (!audio.samples.length) throw new Error('no generó audio');
        return encodeSpeech(pcmToWavPcm16(audio.samples, audio.sampleRate), spoken, trimmed);
      } catch (err) {
        if (signal?.aborted) throw cancelada();
        throw new Error(`la voz local fallo: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
