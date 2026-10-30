/**
 * Ordenes naturales en castellano para la tele -> accion de la tool `tv`.
 * Deterministas (sin LLM): sirven para atajos tipo /tv en Telegram y para que
 * el modelo no tenga que adivinar ids ni teclas. Si no se entiende, null: el
 * modelo sigue con las acciones explicitas.
 *
 *   "apaga la tele"            -> power on:false
 *   "enciende la tele"         -> power on:true
 *   "volumen a 20"             -> volume level:20
 *   "sube el volumen" / "baja 5" -> volumeStep steps:+3 / -5
 *   "silencio" / "quita el silencio" -> mute
 *   "canal 5" / "pon la 1" / "siguiente canal" -> channel
 *   "abre Netflix" / "pon YouTube" -> launch appId:<nombre>
 *   "pausa" / "dale al play"   -> media
 *   "pon el HDMI 2"            -> input hdmi2
 *   "que esta viendo" / "esta encendida" -> status
 *   "modo cine (con Netflix)"  -> scene cine
 */
import { APP_ALIASES, normalizeTvText } from './apps.js';

export type TvIntent =
  | { action: 'power'; on: boolean }
  | { action: 'volume'; level: number }
  | { action: 'volumeStep'; steps: number }
  | { action: 'volumeHalf' }
  | { action: 'mute'; on: boolean }
  | { action: 'channel'; channel: string }
  | { action: 'launch'; appId: string }
  | { action: 'media'; command: 'play' | 'pause' | 'stop' }
  | { action: 'input'; input: string }
  | { action: 'status' }
  | { action: 'scene'; scene: string; appId?: string };

const NUM_WORDS: Record<string, number> = {
  un: 1,
  uno: 1,
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  quince: 15,
  veinte: 20,
  treinta: 30,
};

/** Paso por defecto de "sube/baja el volumen" sin numero. */
export const DEFAULT_VOLUME_STEP = 3;

/** «a tope» / «al máximo» por voz: 100, el máximo de la tele (decisión de Nico, 30-oct-2026: «a tope es a tope»). */
export const VOLUME_TOPE = 100;
const MAX_VOLUME_STEP = 15;

function num(s: string | undefined): number | null {
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  return NUM_WORDS[s] ?? null;
}

const TV = '(?:la )?(?:tele|tv|television|televisor|pantalla)';

export function parseTvCommand(text: string): TvIntent | null {
  const t = normalizeTvText(text)
    .replace(/\bporfa(?:vor)?\b|\bpor favor\b/g, '')
    .trim();
  if (!t) return null;
  let m: RegExpExecArray | null;

  // Rutinas: "modo cine", "pon el modo cine con Netflix", "noche de peli".
  if (/\bmodo (?:cine|pelicula|peli)\b|\bnoche de (?:cine|peli|pelicula)\b/.test(t)) {
    m = /\bcon ([a-z0-9][a-z0-9 .+-]{0,40})$/.exec(t);
    return { action: 'scene', scene: 'cine', ...(m?.[1] ? { appId: m[1].trim() } : {}) };
  }
  // "modo noche", "pon el modo nocturno": volumen bajo sin encender.
  if (/\bmodo (?:noche|nocturno)\b/.test(t)) {
    m = /\bcon ([a-z0-9][a-z0-9 .+-]{0,40})$/.exec(t);
    return { action: 'scene', scene: 'noche', ...(m?.[1] ? { appId: m[1].trim() } : {}) };
  }
  // "apaga todo" / "apagalo todo": aviso y apagar la tele.
  if (/^(?:apaga|apagar|apagalo|apagamelo) todo[\s,.!]*$/.test(t)) {
    return { action: 'scene', scene: 'apagar-todo' };
  }

  // Estado: preguntas, no ordenes.
  if (
    new RegExp(
      `\\b(?:que (?:esta|estan|hay) (?:viendo|puesto|poniendo)|que se ve|esta ${TV} (?:encendida|apagada)|esta encendida|esta apagada|estado de ${TV})\\b`,
    ).test(t)
  ) {
    return { action: 'status' };
  }

  // Sonido antes que energia: "apaga el sonido" es silenciar, no apagar la tele.
  if (
    /\b(?:quita|quitale|desactiva) (?:el )?(?:silencio|mute)\b|\b(?:activa|vuelve|devuelve|pon) (?:el )?sonido\b|\bdesilencia/.test(
      t,
    )
  ) {
    return { action: 'mute', on: false };
  }
  if (
    /\b(?:silencia|silencio|mutea|mute|calla)\b|\b(?:apaga|quita) (?:el )?(?:sonido|audio|volumen)\b/.test(
      t,
    )
  ) {
    return { action: 'mute', on: true };
  }

  if (
    new RegExp(`\\b(?:apaga|apagar|apagame)\\b(?: ${TV})?$`).test(t) ||
    new RegExp(`\\b(?:apaga|apagar) ${TV}\\b`).test(t)
  ) {
    return { action: 'power', on: false };
  }
  if (
    new RegExp(`\\b(?:enciende|encender|enciendeme|prende|prender)\\b(?: ${TV})?$`).test(t) ||
    new RegExp(`\\b(?:enciende|encender|prende) ${TV}\\b`).test(t)
  ) {
    return { action: 'power', on: true };
  }

  // "baja a la mitad", "volumen a la mitad": lee el volumen real y lo deja
  // en la mitad; nunca sube. "sube a la mitad" no entra (seria ambiguo).
  if (
    /^(?:(?:baja(?:le|lo)?|pon(?:me|le)?|deja(?:lo)?|reduce)(?: el)?(?: volumen)?(?: la (?:tele|tv))?|(?:el )?volumen) (?:(?:de|en) (?:la )?(?:tele|tv) )?(?:a|hasta) la mitad(?: (?:(?:a|de|en) )?(?:la )?(?:tele|tv))?$/.test(
      t,
    ) ||
    /^(?:(?:baja|pon|deja)(?:me|le|lo)? )?(?:la )?mitad de(?: el)? volumen$/.test(t)
  ) {
    return { action: 'volumeHalf' };
  }

  // "sube a tope", "volumen al maximo": 100. Nico lo decidio el 30-oct-2026
  // («a tope es a tope»); antes era un tope de seguridad de 50.
  if (
    /^(?:sube(?:le)?(?: el volumen)?|(?:pon(?:me)? )?el volumen|volumen) (?:a|al) (?:tope|maximo|full)(?: (?:(?:a|de) )?(?:la )?(?:tele|tv))?$/.test(
      t,
    )
  ) {
    return { action: 'volume', level: VOLUME_TOPE };
  }

  // Volumen absoluto: "volumen a 20", "pon el volumen al 15", "baja el volumen a 10".
  m = /\bvolumen (?:a|al|en) (\d{1,3}|[a-z]+)\b/.exec(t);
  if (m) {
    const level = num(m[1]);
    if (level !== null && level >= 0 && level <= 100) return { action: 'volume', level };
  }
  // Volumen relativo: "sube el volumen", "baja 5", "sube un poco", "bajale dos".
  m =
    /^(sube|subele|baja|bajale)(?: el)?(?: volumen)?(?: un poco| (\d{1,2}|[a-z]+)(?: puntos?| niveles?)?)?(?: (?:a|de) (?:la )?(?:tele|tv))?$/.exec(
      t,
    );
  if (m?.[1]) {
    const n = m[2] === undefined ? DEFAULT_VOLUME_STEP : num(m[2]);
    if (n !== null && n > 0) {
      const steps = Math.min(MAX_VOLUME_STEP, n);
      return { action: 'volumeStep', steps: m[1].startsWith('sube') ? steps : -steps };
    }
  }
  if (/\bmas alto\b/.test(t)) return { action: 'volumeStep', steps: DEFAULT_VOLUME_STEP };
  if (/\bmas bajo\b/.test(t)) return { action: 'volumeStep', steps: -DEFAULT_VOLUME_STEP };

  // Canales.
  if (
    /\b(?:siguiente canal|canal siguiente|sube (?:de |el )?canal|canal arriba|otro canal)\b/.test(t)
  ) {
    return { action: 'channel', channel: 'up' };
  }
  if (/\b(?:canal anterior|anterior canal|baja (?:de |el )?canal|canal abajo)\b/.test(t)) {
    return { action: 'channel', channel: 'down' };
  }
  m = /\bcanal (?:numero )?(\d{1,4})\b/.exec(t) ?? /^(?:pon|ponme) la (\d{1,2})$/.exec(t);
  if (m?.[1]) return { action: 'channel', channel: String(Number(m[1])) };
  // "pon la uno", "canal cinco": numero en palabras (solo los de NUM_WORDS).
  m = /\bcanal (?:numero )?([a-z]+)$/.exec(t) ?? /^(?:pon|ponme) (?:la|el) ([a-z]+)$/.exec(t);
  if (m?.[1] && /^[a-z]+$/.test(m[1]) && m[1] in NUM_WORDS) {
    return { action: 'channel', channel: String(NUM_WORDS[m[1]]) };
  }

  // Entradas.
  m = /\bhdmi ?([1-4])\b/.exec(t);
  if (m) return { action: 'input', input: `hdmi${m[1]}` };

  // Reproduccion.
  if (/^(?:pausa|pausala|pausalo|para|pausa la (?:peli|pelicula|serie|cancion|video))$/.test(t)) {
    return { action: 'media', command: 'pause' };
  }
  if (/^(?:play|dale al play|reanuda|continua|sigue|quita la pausa)$/.test(t)) {
    return { action: 'media', command: 'play' };
  }

  // Apps: "abre X" acepta cualquier nombre; "pon X" solo nombres conocidos
  // (si no, "pon la 1" o "pon algo de musica" lanzarian apps inventadas).
  m =
    /\b(?:abre|abreme|abrir|lanza|arranca|entra en|quiero ver) (?:el |la |la app de |la aplicacion de )?([a-z0-9][a-z0-9 .+-]{0,40})$/.exec(
      t,
    );
  if (m?.[1]) return { action: 'launch', appId: m[1].trim() };
  m = /\b(?:pon|ponme) (?:el |la )?([a-z0-9][a-z0-9 .+-]{0,40})$/.exec(t);
  if (m?.[1] && APP_ALIASES[m[1].trim()] !== undefined)
    return { action: 'launch', appId: m[1].trim() };

  return null;
}

/** Como se entendio la orden, en castellano (para confirmar al usuario). */
export function describeTvIntent(i: TvIntent): string {
  switch (i.action) {
    case 'power':
      return i.on ? 'encender la tele' : 'apagar la tele';
    case 'volume':
      return `poner el volumen a ${i.level}`;
    case 'volumeHalf':
      return 'bajar el volumen a la mitad';
    case 'volumeStep':
      return i.steps > 0 ? `subir el volumen ${i.steps}` : `bajar el volumen ${-i.steps}`;
    case 'mute':
      return i.on ? 'silenciar la tele' : 'quitar el silencio';
    case 'channel':
      return i.channel === 'up'
        ? 'pasar al siguiente canal'
        : i.channel === 'down'
          ? 'volver al canal anterior'
          : `poner el canal ${i.channel}`;
    case 'launch':
      return `abrir ${i.appId}`;
    case 'media':
      return i.command === 'pause' ? 'pausar' : i.command === 'play' ? 'reanudar' : 'parar';
    case 'input':
      return `cambiar a ${i.input.toUpperCase()}`;
    case 'status':
      return 'mirar el estado de la tele';
    case 'scene':
      if (i.scene === 'apagar-todo') return 'apagarlo todo';
      return `activar el modo ${i.scene}${i.appId ? ` con ${i.appId}` : ''}`;
  }
}
