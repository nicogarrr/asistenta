/**
 * `pa dictado prueba [segundos]`: graba unos segundos del micrófono, lo pasa a
 * texto con la voz local (whisper en este PC, sin claves) y lo enseña limpio.
 * No escribe en ninguna app ni guarda audio ni texto.
 */

import { looksSilent, pcmToWavPcm16, WHISPER_SAMPLE_RATE } from '../voice/audio.js';
import type { WakeCapture } from '../voice/wake.js';
import { ajustesDictado } from './ajustes.js';
import { limpiarDictado } from './limpiar.js';
import type { TeclaDictado } from './tipos.js';

export interface DepsPrueba {
  capture: WakeCapture;
  transcribir: (pcm: Float32Array) => Promise<string>;
  esperar: (ms: number) => Promise<void>;
  out: (linea: string) => void;
  env?: NodeJS.ProcessEnv;
}

export const DICTADO_USAGE =
  'No conozco esa orden. Usa: pa dictado prueba (graba 5 segundos y te enseña el texto; puedes poner los segundos detrás, hasta 30) o pa dictado tecla (comprueba que se nota la tecla).';

/** Une los trozos que entrega la captura en un solo audio. */
export function unirTrozos(trozos: Float32Array[]): Float32Array {
  const pcm = new Float32Array(trozos.reduce((n, t) => n + t.length, 0));
  let i = 0;
  for (const t of trozos) {
    pcm.set(t, i);
    i += t.length;
  }
  return pcm;
}

/** Transcriptor por defecto: la misma voz local que las notas de voz. */
export async function transcribirLocal(pcm: Float32Array): Promise<string> {
  const { createLocalWhisperStt } = await import('../voice/stt.js');
  const wav = pcmToWavPcm16(pcm, WHISPER_SAMPLE_RATE);
  const r = await createLocalWhisperStt().transcribe(wav, { mimeType: 'audio/wav' });
  return r.text;
}

const mensaje = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function dictadoPrueba(args: string[], deps: DepsPrueba): Promise<number> {
  const n = args[0] === undefined ? 5 : Number(args[0].replace(',', '.'));
  if (!Number.isFinite(n) || n < 1 || n > 30) {
    deps.out(DICTADO_USAGE);
    return 2;
  }
  const trozos: Float32Array[] = [];
  let fallo: Error | null = null;
  try {
    await deps.capture.start(
      (pcm) => trozos.push(pcm),
      (err) => {
        fallo = err;
      },
    );
  } catch (err) {
    deps.out(`No puedo usar el micrófono: ${mensaje(err)}`);
    return 1;
  }
  deps.out(`Habla ahora (${n} s)…`);
  try {
    await deps.esperar(n * 1000);
  } finally {
    await deps.capture.stop().catch(() => {});
  }
  if (fallo) {
    deps.out(`El micrófono falló mientras grababa: ${mensaje(fallo)}`);
    return 1;
  }
  const pcm = unirTrozos(trozos);
  if (pcm.length === 0 || looksSilent(pcm)) {
    deps.out('No he oído nada. Mira que el micrófono esté conectado y no silenciado.');
    return 1;
  }
  let bruto: string;
  try {
    bruto = await deps.transcribir(pcm);
  } catch (err) {
    deps.out(`No he podido pasarlo a texto: ${mensaje(err)}`);
    return 1;
  }
  const limpio = limpiarDictado(bruto);
  if (!limpio) {
    deps.out('No he entendido ninguna palabra. Prueba otra vez hablando un poco más cerca.');
    return 1;
  }
  deps.out(`Texto: ${limpio}`);
  if (!ajustesDictado(deps.env).activo) {
    deps.out('El dictado con tecla está apagado: pon PA_DICTADO=1 en el .env para usarlo.');
  }
  return 0;
}

/** `pa dictado tecla`: comprueba que se nota la tecla (y se oyen los pitidos), sin grabar nada. */
export async function dictadoTecla(deps: {
  tecla: (vk: number[][]) => TeclaDictado;
  esperar: (ms: number) => Promise<void>;
  out: (linea: string) => void;
  env?: NodeJS.ProcessEnv;
  plataforma?: NodeJS.Platform;
}): Promise<number> {
  if ((deps.plataforma ?? process.platform) !== 'win32') {
    deps.out('La tecla del dictado solo funciona en Windows.');
    return 1;
  }
  const a = ajustesDictado(deps.env);
  if (!a.tecla) {
    deps.out(
      `No entiendo PA_DICTADO_TECLA «${a.teclaTexto.slice(0, 30)}». Usa por ejemplo ctrl+win o ctrl+alt.`,
    );
    return 2;
  }
  const visto = { pulsada: false, soltada: false };
  const tecla = deps.tecla(a.tecla);
  await tecla.start(
    () => {
      visto.pulsada = true;
    },
    () => {
      visto.soltada = visto.pulsada;
    },
  );
  deps.out(`Mantén ${a.teclaTexto} un momento y suéltala (tienes 15 s)…`);
  for (let i = 0; i < 150 && !visto.soltada; i++) await deps.esperar(100);
  await tecla.stop();
  if (!visto.soltada) {
    deps.out(
      'No he notado la tecla. Prueba otra con PA_DICTADO_TECLA (por ejemplo ctrl+alt o f9).',
    );
    return 1;
  }
  deps.out(
    'Bien: la tecla funciona. Al pulsarla suena un pitido agudo y al soltarla uno más grave.',
  );
  return 0;
}

/** Entrada de `pa dictado …`. */
export async function dictadoCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const out = (l: string) => process.stdout.write(`${l}\n`);
  const esperar = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  if (sub === 'tecla') {
    const { TeclaWindows } = await import('./windows.js');
    return dictadoTecla({ tecla: (vk) => new TeclaWindows(vk), esperar, out });
  }
  if (sub !== 'prueba') {
    out(DICTADO_USAGE);
    return 2;
  }
  const { FfmpegMicCapture } = await import('../voice/wake.js');
  return dictadoPrueba(rest, {
    capture: new FfmpegMicCapture(),
    transcribir: transcribirLocal,
    esperar,
    out,
  });
}
