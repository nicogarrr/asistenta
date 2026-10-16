/**
 * Scorer de habla para confirmar el corte (barge-in) con Silero VAD.
 *
 * El disparo por energía interrumpe al agente con cualquier ruido sostenido por
 * encima del umbral (aspiradora, platos, tele); la métrica de falsos disparos lo
 * cuenta pero el corte ya ha ocurrido. El bench de A5 midió que silero-vad v4.0
 * rechaza 19/19 tramos de ruido blanco donde el gate RMS pasa 19/19, y mantiene
 * 105/105 segmentos de habla real — así que un candidato ruidoso se confirma por
 * FORMA antes de cortar el sonido, no después por la transcripción.
 *
 * El scorer es perezoso (el modelo se descarga/crea en el primer candidato) y se
 * comparte entre sesiones: una conversación tiene como mucho un chequeo en vuelo,
 * así que una única sesión ONNX basta. Cada candidato se puntúa como ventana
 * independiente (reset previo): dos candidatos no son audio contiguo y el estado
 * LSTM del anterior no debe contaminar éste.
 */

import { log } from '../log.js';
import { SileroVad, VAD_WINDOW_SAMPLES, type VadSessionFactory } from './vad-silero.js';

export interface BargeVadScorerOptions {
  /** Directorio donde ensureVadModel descarga silero_vad.onnx (paths.models). */
  modelDir: string;
  factory?: VadSessionFactory;
  fetchImpl?: typeof fetch;
}

/** Vad mínimo que la puntuación necesita; lo cumple SileroVad. */
export interface VadLike {
  reset(): void;
  pushFrame(frame: Float32Array): Promise<number>;
}

/**
 * Prob de habla (0..1) de una ventana de audio, como el máximo de sus frames de
 * 512 muestras. Reset previo: el candidato es una ventana aislada, no la
 * continuación del stream. Menos de una ventana se puntúa con padding de ceros.
 */
export async function scoreSamples(vad: VadLike, samples: Float32Array): Promise<number> {
  vad.reset();
  let max = -1;
  for (let at = 0; at + VAD_WINDOW_SAMPLES <= samples.length; at += VAD_WINDOW_SAMPLES) {
    const prob = await vad.pushFrame(samples.subarray(at, at + VAD_WINDOW_SAMPLES));
    if (prob > max) max = prob;
  }
  if (max < 0) {
    const frame = new Float32Array(VAD_WINDOW_SAMPLES);
    frame.set(samples.subarray(0, VAD_WINDOW_SAMPLES));
    max = await vad.pushFrame(frame);
  }
  return max;
}

export function createBargeVadScorer(
  opts: BargeVadScorerOptions,
): (samples: Float32Array) => Promise<number> {
  let vadPromise: Promise<SileroVad> | null = null;
  const load = (): Promise<SileroVad> => {
    vadPromise ??= SileroVad.create({
      modelDir: opts.modelDir,
      factory: opts.factory,
      fetchImpl: opts.fetchImpl,
    }).catch((err) => {
      // Un modelo que no carga no se memoiza: el próximo candidato reintenta.
      vadPromise = null;
      log.warn('barge vad: no se pudo preparar el modelo', { error: String(err) });
      throw err;
    });
    return vadPromise;
  };

  return async (samples: Float32Array): Promise<number> => scoreSamples(await load(), samples);
}
