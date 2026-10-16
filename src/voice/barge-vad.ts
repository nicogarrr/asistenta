/**
 * Scorer de habla para confirmar el corte (barge-in) con Silero VAD.
 *
 * El disparo por energía interrumpe al agente con cualquier ruido sostenido por
 * encima del umbral (aspiradora, platos, tele); la métrica de falsos disparos lo
 * cuenta pero el corte ya ha ocurrido. En el bench local de A5 (banco propio en
 * el PC de Nico, sin verificación del auditor) silero-vad v4.0 rechazó 19/19
 * tramos de ruido blanco donde el gate RMS pasó 19/19, y mantuvo 105/105
 * segmentos de habla real — así que un candidato ruidoso se confirma por FORMA
 * antes de cortar el sonido, no después por la transcripción.
 *
 * El scorer es perezoso (el modelo se descarga/crea en el primer candidato) y se
 * comparte entre sesiones, así que las puntuaciones se SERIALIZAN enteras: el
 * reset y todos los frames de un candidato corren antes de que empiece el
 * siguiente. Una sesión ONNX lleva estado LSTM; dos scoreSamples entrelazados
 * (p.ej. un chequeo tardío de la reproducción A contra un candidato de la B)
 * contaminarían ambas ventanas. Cada candidato se puntúa como ventana
 * independiente (reset previo): dos candidatos no son audio contiguo y el
 * estado LSTM del anterior no debe contaminar éste.
 *
 * Las cifras del bench de A5 citadas arriba (19/19 ruidos rechazados, 105/105
 * segmentos de habla conservados) son de un banco LOCAL en el PC de Nico, no
 * verificadas por el auditor: orientan el diseño, no son una garantía medida.
 */

import { log } from '../log.js';
import { SileroVad, VAD_WINDOW_SAMPLES, type VadSessionFactory } from './vad-silero.js';

export interface BargeVadScorerOptions {
  /** Directorio donde ensureVadModel descarga silero_vad.onnx (paths.models). */
  modelDir: string;
  factory?: VadSessionFactory;
  fetchImpl?: typeof fetch;
  /** Costura de tests: instancia ya construida, sin fichero de modelo. */
  vadInstance?: SileroVad;
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
  /** Cola que serializa scoreSamples ENTERO (reset + frames) entre llamadas. */
  let queue: Promise<unknown> = Promise.resolve();
  let vadPromise: Promise<SileroVad> | null = null;
  const load = (): Promise<SileroVad> => {
    if (opts.vadInstance) return Promise.resolve(opts.vadInstance);
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

  return (samples: Float32Array): Promise<number> => {
    const run = queue.then(async () => scoreSamples(await load(), samples));
    // La cola nunca se rompe por un fallo: el siguiente candidato puntúa igual.
    queue = run.catch(() => {});
    return run;
  };
}
