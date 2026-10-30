/**
 * `pa audio prueba-tele <fichero.mp3> [--via media.viewer|launcher|glasshouse]`:
 * manda un audio a la tele con la misma ruta que «reprodúcelo en la tele» y dice qué
 * vía aceptó la tele y si llegó a descargar el fichero. Sirve para saber, en la tele
 * real, cuál de las APIs funciona (docs/audio-altavoz.md).
 */
import { TV_CAST_VIAS, TV_FIREWALL_HINT, type TvCastResult, type TvCastVia } from './tv-cast.js';

export const PRUEBA_TELE_USAGE =
  'Uso: pa audio prueba-tele <fichero.mp3> [--via media.viewer|launcher|glasshouse]';

export interface AudioCliDeps {
  /** Copia el fichero (el envío se queda con la copia y la borra). */
  copyToTemp(file: string): Promise<string>;
  cast(file: string, only?: TvCastVia): Promise<TvCastResult>;
  print(line: string): void;
  sleep(ms: number): Promise<void>;
  /** Cuánto esperar a que la tele descargue el fichero. */
  fetchWaitMs?: number;
}

type Parsed = { file: string; only?: TvCastVia } | { error: string };

export function parsePruebaTele(args: string[]): Parsed {
  let file: string | undefined;
  let only: TvCastVia | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '--via') {
      const v = args[++i] ?? '';
      if (!(TV_CAST_VIAS as readonly string[]).includes(v)) {
        return { error: `Vía desconocida «${v}». ${PRUEBA_TELE_USAGE}` };
      }
      only = v as TvCastVia;
    } else if (!file) {
      file = a;
    } else {
      return { error: PRUEBA_TELE_USAGE };
    }
  }
  if (!file) return { error: PRUEBA_TELE_USAGE };
  return { file, only };
}

/** Devuelve el código de salida: 0 la tele descargó el audio, 1 falló, 2 uso. */
export async function audioCommand(args: string[], deps: AudioCliDeps): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== 'prueba-tele') {
    deps.print(PRUEBA_TELE_USAGE);
    return 2;
  }
  const parsed = parsePruebaTele(rest);
  if ('error' in parsed) {
    deps.print(parsed.error);
    return 2;
  }
  let copy: string;
  try {
    copy = await deps.copyToTemp(parsed.file);
  } catch (err) {
    deps.print(`No puedo leer ${parsed.file}: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  const r = await deps.cast(copy, parsed.only);
  for (const t of r.tried ?? []) deps.print(`✗ ${t}`);
  if (!r.ok) {
    deps.print(`✗ ${r.message}`);
    return 1;
  }
  deps.print(`✓ La tele aceptó la orden por ${r.via}.`);
  const wait = deps.fetchWaitMs ?? 15_000;
  const step = 500;
  for (let waited = 0; waited < wait && (r.hits?.() ?? 0) === 0; waited += step) {
    await deps.sleep(step);
  }
  if ((r.hits?.() ?? 0) === 0) {
    deps.print(`✗ ${TV_FIREWALL_HINT}`);
    return 1;
  }
  deps.print('✓ La tele ha descargado el audio. Si no lo has oído, sube el volumen de la tele.');
  return 0;
}
