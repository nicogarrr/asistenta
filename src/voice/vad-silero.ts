/**
 * Item A5 — Silero VAD (v4.0) como runner ONNX in-process (infraestructura).
 *
 * Para qué existe: el stage-1 del listener (src/voice/wake.ts) es un gate de
 * energía RMS que deja pasar cualquier ventana ruidosa — whisper se ejecuta
 * sobre ruido fuerte y puede alucinar texto (documentado en wake.ts con un
 * caso medido). Un VAD rechaza el no-habla por FORMA, no por volumen. El
 * comentario original de wake.ts descartó la idea por el coste de otra sesión
 * ONNX; la medición del spike A5 la refuta y la acota (ver scripts/
 * vad-silero-bench.py y el body de la PR):
 *
 *   - Ruido blanco a RMS 0.05-0.2 (donde el gate actual pasa 19/19 tramos de
 *     3s): VAD rechaza 19/19 (prob mediana <= 0.025).
 *   - Música orquestal sin voz: VAD@0.5 pasa ~45-47/86 tramos donde RMS pasa
 *     85/86 — reduce invocaciones a whisper ~45%, NO la resuelve: pasajes
 *     sostenidos le parecen voz (p95 0.92-0.98). Límite declarado.
 *   - Habla: 105/105 segmentos reales "chochi" con prob máx >= 0.996; nico1
 *     completo pasa 12/13 tramos, igual que el gate RMS. Sin pérdida de habla.
 *   - Coste: 76s CPU/hora en Python naive (process_time, un solo hilo; ~2,1%
 *     de un core; afinar con la sesión TS real en la decisión de adopción).
 *
 * Fuentes del spike: Wikimedia Commons, dominio público, con sha256
 * registrado (ruido dde19c99..., música 2e415a0e...). Modelo: release
 * OFICIAL snakers4/silero-vad v4.0 (MIT), verificado byte a byte contra
 * https://github.com/snakers4/silero-vad/raw/v4.0/files/silero_vad.onnx
 * (sha256 a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28).
 *
 * Contrato del modelo (inspeccionado del propio .onnx, no de memoria):
 *   inputs:  input [batch, seq] float32 (seq = 512 @16kHz = 32ms),
 *            sr escalar int64 (16000), h y c [2, batch, 64] float32.
 *   outputs: output [batch, 1] (prob de habla), hn y cn (estado siguiente).
 *
 * Esto es infra: NO está cableado al listener. La adopción como stage-1 es
 * una decisión medida aparte (igual que A1a -> A1b).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { log } from '../log.js';

export const VAD_SAMPLE_RATE = 16_000;
/** Una ventana: 32ms a 16kHz (el único tamaño válido del modelo a 16k). */
export const VAD_WINDOW_SAMPLES = 512;
/** Estado LSTM del modelo: h y c [2, batch, 64]. */
export const VAD_STATE_DIM = 64;
export const VAD_STATE_LAYERS = 2;

/** Release oficial silero-vad v4.0 (MIT). */
export const VAD_MODEL_URL =
  'https://github.com/snakers4/silero-vad/raw/v4.0/files/silero_vad.onnx';
export const VAD_MODEL_FILE = 'silero_vad.onnx';
/** sha256 del fichero oficial v4.0, verificado byte a byte en el spike. */
export const VAD_MODEL_SHA256 = 'a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28';

/** Un fichero de modelo más pequeño que esto es una página 404, no un modelo. */
const MIN_MODEL_BYTES = 100_000;

/** Sufijo único por invocación: dos ensureVadModel concurrentes en el mismo
 * proceso nunca comparten temp (auditor A5 r1: con temp por proceso, el catch
 * de una borraba el .partial de la otra y su rename moría con ENOENT). */
let vadTmpCounter = 0;

/** Tensor mínimo: float32 para audio/estado, int64 para sr. */
export interface VadTensor {
  data: Float32Array | BigInt64Array;
  dims: readonly number[];
}

/** Sesión mínima — satisfecha por onnxruntime-node. */
export interface VadSession {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, VadTensor>): Promise<Record<string, VadTensor>>;
  release(): Promise<void>;
}

export type VadSessionFactory = (modelPath: string) => Promise<VadSession>;

/** Sesión real via onnxruntime-node (ya en el árbol de dependencias). */
export const vadOnnxSessionFactory: VadSessionFactory = async (modelPath) => {
  // createRequire: onnxruntime-node es CommonJS; un import estático ataría el
  // grafo de módulos a un binario nativo incluso en tests que inyectan fakes.
  const require = createRequire(import.meta.url);
  const ort = require('onnxruntime-node') as typeof import('onnxruntime-node');
  const inner = await ort.InferenceSession.create(modelPath);
  return {
    inputNames: inner.inputNames,
    outputNames: inner.outputNames,
    run: async (feeds) => {
      const real: Record<string, import('onnxruntime-node').Tensor> = {};
      for (const [k, v] of Object.entries(feeds)) {
        real[k] =
          v.data instanceof BigInt64Array
            ? new ort.Tensor('int64', v.data, [...v.dims])
            : new ort.Tensor('float32', v.data, [...v.dims]);
      }
      const out = (await inner.run(real)) as Record<
        string,
        { data: Float32Array; dims: readonly number[] }
      >;
      const mapped: Record<string, VadTensor> = {};
      for (const [k, v] of Object.entries(out)) mapped[k] = { data: v.data, dims: v.dims };
      return mapped;
    },
    release: () => inner.release(),
  };
};

type FetchLike = typeof fetch;

/**
 * Descarga silero_vad.onnx en `dir` si no está ya presente. Misma disciplina
 * que ensureOwwModels: descarga a temp único con `wx` y rename, para que una
 * descarga muerta o concurrente nunca deje un modelo truncado. Además aquí el
 * contenido se verifica contra el sha256 oficial v4.0: un fichero con el
 * tamaño correcto pero contenido distinto es un error, no un modelo.
 */
export async function ensureVadModel(
  dir: string,
  fetchImpl: FetchLike = fetch,
  expectedSha256: string = VAD_MODEL_SHA256,
): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, VAD_MODEL_FILE);
  if (existsSync(target) && statSync(target).size >= MIN_MODEL_BYTES) {
    const sha = createHash('sha256')
      .update(await readFile(target))
      .digest('hex');
    if (sha === expectedSha256) return target;
    log.warn('vad: modelo presente con sha256 distinto al esperado; se redescarga', { target });
  }
  log.info('vad model download', { url: VAD_MODEL_URL, target });
  const res = await fetchImpl(VAD_MODEL_URL);
  if (!res.ok || !res.body) {
    throw new Error(`descarga de silero_vad falló (${res.status}): ${VAD_MODEL_URL}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength < MIN_MODEL_BYTES) {
    throw new Error(
      `descarga de silero_vad demasiado pequeña (${buf.byteLength} B, ¿404?): ${VAD_MODEL_URL}`,
    );
  }
  const sha = createHash('sha256').update(buf).digest('hex');
  if (sha !== expectedSha256) {
    throw new Error(
      `descarga de silero_vad con sha256 inesperado (${sha}); esperado ${expectedSha256}`,
    );
  }
  const tmp = `${target}.${process.pid}.${vadTmpCounter++}.partial`;
  try {
    await writeFile(tmp, buf, { flag: 'wx' });
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return target;
}

const zeroState = (): Float32Array => new Float32Array(VAD_STATE_LAYERS * VAD_STATE_DIM);

/**
 * Scorer VAD en streaming fiel al modelo oficial silero-vad v4.0: cada push de
 * 512 muestras float [-1,1] devuelve la prob de habla de ESA ventana, llevando
 * el estado LSTM (h, c) entre ventanas. Sin warmup: la primera ventana ya
 * devuelve prob (estado inicial en ceros, como hace la referencia oficial).
 *
 * Ciclo de vida idéntico a OwwWakeDetector (auditor #138 r3): pushes
 * SERIALIZADOS por una cadena interna (concurrencia sin entrelazar awaits);
 * reset() sube una generación e invalida TODO el audio recibido (activo y
 * encolado: la generación se captura al encolar y se re-chequea tras cada
 * await); close() bloquea pushes nuevos, drena el push en curso y sólo
 * entonces libera la sesión, con reintento si un release falla. Los frames se
 * copian al encolar: un productor que reutilice su buffer no puede mutar
 * audio ya entregado.
 */
export class SileroVad {
  private readonly session: VadSession;
  private h: Float32Array = zeroState();
  private c: Float32Array = zeroState();
  private closed = false;
  /** Cadena de serialización: como mucho un push corre sus awaits a la vez. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Subido por reset(); los pushes en vuelo con generación vieja descartan. */
  private generation = 0;
  private unreleased: VadSession[];
  private closeInFlight: Promise<void> | undefined;

  private constructor(session: VadSession) {
    this.session = session;
    this.unreleased = [session];
  }

  static async create(opts: {
    modelDir: string;
    factory?: VadSessionFactory;
    fetchImpl?: FetchLike;
  }): Promise<SileroVad> {
    const modelPath = await ensureVadModel(opts.modelDir, opts.fetchImpl);
    const factory = opts.factory ?? vadOnnxSessionFactory;
    let session: VadSession | undefined;
    try {
      session = await factory(modelPath);
      return new SileroVad(session);
    } catch (err) {
      if (session) {
        const res = await Promise.allSettled([session.release()]);
        if (res[0]?.status === 'rejected') {
          log.error('vad create: cleanup de sesión falló');
        }
      }
      throw err;
    }
  }

  /** Costura de tests: construir sobre una sesión falsa, sin ficheros. */
  static overSession(session: VadSession): SileroVad {
    return new SileroVad(session);
  }

  /**
   * Olvida el contexto de audio acumulado (p.ej. tras un hueco largo de
   * supresión): estado LSTM a ceros y generación nueva, para que ningún push
   * pre-reset repueble el estado.
   */
  reset(): void {
    this.generation++;
    this.h = zeroState();
    this.c = zeroState();
  }

  /** Prob de habla (0..1) de una ventana de 512 muestras float [-1,1]. */
  async pushFrame(frame: Float32Array): Promise<number> {
    if (this.closed) throw new Error('SileroVad cerrado');
    if (frame.length !== VAD_WINDOW_SAMPLES) {
      throw new Error(
        `frame vad debe tener ${VAD_WINDOW_SAMPLES} muestras; recibido ${frame.length}`,
      );
    }
    // Copia al encolar: el productor puede reutilizar el buffer.
    const owned = frame.slice();
    // Generación al ENCOLAR: reset() invalida también los pushes pendientes.
    const gen = this.generation;
    const task = this.chain.then(() => this.doPush(owned, gen));
    this.chain = task.catch(() => undefined);
    return task;
  }

  private async doPush(frame: Float32Array, gen: number): Promise<number> {
    // Encolado antes de un reset: es audio pre-reset. Descartar SIN tocar
    // el estado (repoblarlo sería mezclar contextos de audio distintos).
    if (gen !== this.generation) return -1;
    const inName = this.session.inputNames[0] ?? 'input';
    const out = await this.session.run({
      [inName]: { data: frame, dims: [1, VAD_WINDOW_SAMPLES] },
      sr: { data: new BigInt64Array([BigInt(VAD_SAMPLE_RATE)]), dims: [] },
      h: { data: this.h, dims: [VAD_STATE_LAYERS, 1, VAD_STATE_DIM] },
      c: { data: this.c, dims: [VAD_STATE_LAYERS, 1, VAD_STATE_DIM] },
    });
    if (gen !== this.generation) return -1; // reset durante el await: descartar
    const prob = out[this.session.outputNames[0] ?? 'output'];
    const hn = out.hn;
    const cn = out.cn;
    if (!prob || prob.data.length === 0) throw new Error('silero_vad no devolvió prob');
    if (!(prob.data instanceof Float32Array))
      throw new Error('silero_vad devolvió prob no float32');
    if (!hn || !cn) throw new Error('silero_vad no devolvió estado siguiente');
    if (!(hn.data instanceof Float32Array) || hn.data.length !== this.h.length) {
      throw new Error('silero_vad devolvió hn con forma inesperada');
    }
    if (!(cn.data instanceof Float32Array) || cn.data.length !== this.c.length) {
      throw new Error('silero_vad devolvió cn con forma inesperada');
    }
    this.h = new Float32Array(hn.data);
    this.c = new Float32Array(cn.data);
    return prob.data[0] ?? -1;
  }

  /**
   * Bloquea pushes nuevos, espera al push en curso y sólo entonces libera la
   * sesión: run nunca se llama sobre una sesión liberada. Un release fallido
   * se loguea y se relanza manteniendo la sesión en `unreleased`, así un
   * close() posterior lo reintenta.
   */
  async close(): Promise<void> {
    this.closed = true;
    if (this.unreleased.length === 0) return;
    this.closeInFlight ??= (async () => {
      await this.chain; // nunca rechaza; drena el push en curso
      const pending = [...this.unreleased];
      const results = await Promise.allSettled(pending.map((s) => s.release()));
      const stillPending: VadSession[] = [];
      let failed = 0;
      for (let i = 0; i < results.length; i++) {
        if (results[i]?.status === 'fulfilled') continue;
        failed++;
        const s = pending[i];
        if (s) stillPending.push(s);
      }
      this.unreleased = stillPending;
      if (failed > 0) {
        log.error('vad close: releases fallaron', { failed, pending: stillPending.length });
        throw new Error(`vad close: ${failed} release(s) fallaron; reintenta close()`);
      }
    })();
    try {
      await this.closeInFlight;
    } finally {
      // Un intento fallido no debe memoizarse a sí mismo fuera de los reintentos.
      if (this.unreleased.length > 0) this.closeInFlight = undefined;
    }
  }
}
