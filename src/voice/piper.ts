/**
 * Voz local de respaldo con Piper (https://github.com/rhasspy/piper): gratis, sin
 * red y con voces neuronales en español (p. ej. es_ES-davefx-medium.onnx). Va detrás
 * de la misma interfaz `Tts` que SAPI y está APAGADA por defecto: solo se usa si
 * `PA_PIPER_MODEL` apunta a un modelo .onnx descargado.
 *
 * Cuándo entra:
 * - `PA_TTS=piper`: siempre Piper.
 * - Con `PA_PIPER_MODEL` puesto: si SAPI no existe o no tiene ninguna voz en español,
 *   Piper va primero; si SAPI tiene voz española, SAPI va primero y Piper solo
 *   cuando SAPI falla.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSapiTts,
  encodeSpeech,
  type Tts,
  type TtsAudio,
  type TtsSpeakOptions,
  truncateForSpeech,
  voices,
} from './tts.js';

/** Mismo techo que SAPI: un Piper colgado no puede retener la respuesta. */
const PIPER_TIMEOUT_MS = 60_000;

/** Ejecuta Piper con el texto por stdin; debe dejar el WAV en `--output_file`. */
export type PiperRunner = (
  bin: string,
  args: string[],
  input: string,
  opts: { timeoutMs: number; signal?: AbortSignal },
) => Promise<void>;

const defaultRunner: PiperRunner = (bin, args, input, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, signal: opts.signal });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`piper no terminó en ${Math.round(opts.timeoutMs / 1000)} s`));
    }, opts.timeoutMs);
    child.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString('utf8')).slice(-2000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `piper salió con código ${code}`));
    });
    child.stdin?.end(input, 'utf8');
  });

export interface PiperOptions {
  model: string;
  bin?: string;
  run?: PiperRunner;
}

export function createPiperTts(opts: PiperOptions): Tts {
  const bin = opts.bin || 'piper';
  const run = opts.run ?? defaultRunner;
  return {
    name: 'piper',
    async speak(text: string, speakOpts: TtsSpeakOptions = {}): Promise<TtsAudio> {
      const trimmed = text.trim();
      if (!trimmed) throw new Error('no hay texto que decir');
      if (speakOpts.signal?.aborted) throw new Error('sintesis cancelada');
      const spoken = truncateForSpeech(trimmed);
      const dir = mkdtempSync(join(tmpdir(), 'pa-piper-'));
      const wavFile = join(dir, 'voz.wav');
      try {
        // Una línea = una frase para Piper: los saltos se vuelven espacios.
        await run(
          bin,
          ['--model', opts.model, '--output_file', wavFile],
          spoken.replace(/\s+/g, ' '),
          {
            timeoutMs: PIPER_TIMEOUT_MS,
            signal: speakOpts.signal,
          },
        );
        return encodeSpeech(readFileSync(wavFile), spoken, trimmed);
      } catch (err) {
        if (speakOpts.signal?.aborted) throw new Error('sintesis cancelada');
        throw new Error(
          `la voz de Piper fallo: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/** Primero `primary`; si falla (no si se cancela), `fallback`. */
export function withFallback(
  primary: Tts,
  fallback: Tts,
  onFallback?: (err: unknown) => void,
): Tts {
  return {
    name: `${primary.name}+${fallback.name}`,
    async speak(text, opts = {}) {
      try {
        return await primary.speak(text, opts);
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        onFallback?.(err);
        return fallback.speak(text, { ...opts, voice: undefined });
      }
    },
  };
}

const SPANISH_VOICE =
  /\b(es[-_](es|mx|us|ar|co)|spanish|espa[nñ]ol|helena|laura|pablo|sabina|raul|elvira|alvaro|dalia|jorge|elena)\b/i;

export function hasSpanishVoice(names: readonly string[]): boolean {
  return names.some((n) => SPANISH_VOICE.test(n));
}

export interface DefaultTtsDeps {
  sapi?: Tts;
  piper?: Tts;
  listVoices?: () => Promise<string[]>;
  onFallback?: (err: unknown) => void;
}

/**
 * El sintetizador del daemon. Sin `PA_PIPER_MODEL` es SAPI tal cual (comportamiento
 * de siempre). Con él, decide una vez (perezosamente, en la primera frase) el orden.
 */
export function createDefaultTts(
  env: NodeJS.ProcessEnv = process.env,
  deps: DefaultTtsDeps = {},
): Tts {
  const sapi = deps.sapi ?? createSapiTts();
  const model = env.PA_PIPER_MODEL?.trim();
  if (!model) return sapi;
  const piper = deps.piper ?? createPiperTts({ model, bin: env.PA_PIPER_BIN?.trim() || undefined });
  if (env.PA_TTS?.trim().toLowerCase() === 'piper') return piper;
  const listVoices = deps.listVoices ?? voices;
  let chosen: Promise<Tts> | null = null;
  const choose = (): Promise<Tts> => {
    chosen ??= listVoices()
      .catch(() => [] as string[])
      .then((names) =>
        hasSpanishVoice(names)
          ? withFallback(sapi, piper, deps.onFallback)
          : withFallback(piper, sapi, deps.onFallback),
      );
    return chosen;
  };
  return {
    name: 'auto',
    async speak(text, opts) {
      return (await choose()).speak(text, opts);
    },
  };
}
