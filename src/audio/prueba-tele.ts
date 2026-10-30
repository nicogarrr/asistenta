/**
 * `pa audio prueba-tele <fichero.mp3> [--via media.viewer|launcher|glasshouse]`:
 * manda un audio a la tele con la misma ruta que «reprodúcelo en la tele» y dice qué
 * vía aceptó la tele y si llegó a descargar el fichero. Sirve para saber, en la tele
 * real, cuál de las APIs funciona (docs/audio-altavoz.md).
 */
import { TV_CAST_VIAS, TV_FIREWALL_HINT, type TvCastResult, type TvCastVia } from './tv-cast.js';

export const PRUEBA_TELE_USAGE =
  'Uso: pa audio prueba-tele <fichero.mp3> [--via media.viewer|launcher|glasshouse] (también --via=…)';

export interface AudioCliDeps {
  /** Copia el fichero (el envío se queda con la copia y la borra). */
  copyToTemp(file: string): Promise<string>;
  cast(file: string, only?: TvCastVia): Promise<TvCastResult>;
  print(line: string): void;
  sleep(ms: number): Promise<void>;
  /** Borra la copia temporal si el envío falla antes de quedársela. */
  discard?(file: string): void;
  /** Cuánto esperar a que la tele descargue el fichero. */
  fetchWaitMs?: number;
}

type Parsed = { file: string; only?: TvCastVia } | { help: true } | { error: string };

function checkVia(v: string): TvCastVia | { error: string } {
  if (!(TV_CAST_VIAS as readonly string[]).includes(v)) {
    return { error: `Vía desconocida «${v}». ${PRUEBA_TELE_USAGE}` };
  }
  return v as TvCastVia;
}

export function parsePruebaTele(args: string[]): Parsed {
  let file: string | undefined;
  let only: TvCastVia | undefined;
  let rest = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (!rest && (a === '--help' || a === '-h')) return { help: true };
    if (!rest && a === '--') {
      rest = true;
      continue;
    }
    if (!rest && (a === '--via' || a.startsWith('--via='))) {
      // `--via launcher` y `--via=launcher` (antes la segunda se tomaba como fichero).
      const v = checkVia(a === '--via' ? (args[++i] ?? '') : a.slice('--via='.length));
      if (typeof v !== 'string') return v;
      only = v;
    } else if (!rest && a.startsWith('-') && a !== '-') {
      return { error: `Opción desconocida «${a}». ${PRUEBA_TELE_USAGE}` };
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
  if ('help' in parsed) {
    deps.print(PRUEBA_TELE_USAGE);
    return 0;
  }
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
  let r: TvCastResult;
  try {
    r = await deps.cast(copy, parsed.only);
  } catch (err) {
    // Un fallo antes de llegar a la tele (p. ej. leyendo el emparejamiento del vault)
    // salía como traza sin capturar y dejaba la copia temporal en disco.
    deps.discard?.(copy);
    deps.print(
      `✗ No he podido mandar el audio a la tele: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
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
    // Nadie lo va a bajar: el servidor LAN se cierra ya (si no, el comando seguía
    // colgado hasta el ttl de 10 min con el puerto abierto).
    r.close?.();
    deps.print(`✗ ${TV_FIREWALL_HINT}`);
    return 1;
  }
  deps.print('✓ La tele ha descargado el audio. Si no lo has oído, sube el volumen de la tele.');
  deps.print(
    'Sigo sirviendo el audio a la tele mientras suena (10 min como mucho). Pulsa Ctrl+C para terminar antes.',
  );
  return 0;
}
