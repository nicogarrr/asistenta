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
  | { action: 'volumeStep'; steps: number; requested?: number }
  | { action: 'volumeHalf' }
  | { action: 'mute'; on: boolean }
  | { action: 'channel'; channel: string }
  | { action: 'launch'; appId: string }
  | { action: 'media'; command: 'play' | 'pause' | 'stop' | 'rewind' | 'fastForward' }
  | { action: 'input'; input: string }
  | { action: 'status' }
  | { action: 'scene'; scene: string; appId?: string }
  | { action: 'key'; name: TvKeyName }
  | { action: 'picture'; pictureMode: string };

/** Modos de imagen de LG que se pueden pedir con palabras («pon la imagen en estándar»). */
const PICTURE_WORDS: ReadonlyArray<[RegExp, string]> = [
  [/^(?:estandar|normal)$/, 'standard'],
  [/^(?:oscura|eco|ahorro|ahorro de energia)$/, 'eco'],
  [/^(?:cine|pelicula|peli)$/, 'cinema'],
  [/^(?:viva|vivo|vivida|vivido|intensa|intenso|brillante)$/, 'vivid'],
  [/^(?:juego|juegos|videojuegos)$/, 'game'],
  [/^(?:deporte|deportes|futbol)$/, 'sports'],
];

const PICTURE_NAMES: Record<string, string> = {
  standard: 'estándar',
  eco: 'oscuro (eco)',
  cinema: 'cine',
  vivid: 'vivo',
  game: 'juego',
  sports: 'deportes',
};

/** Números en palabras (texto ya sin tildes), 0–100. */
const NUM_WORDS: Record<string, number> = {
  cero: 0,
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
  once: 11,
  doce: 12,
  trece: 13,
  catorce: 14,
  quince: 15,
  dieciseis: 16,
  diecisiete: 17,
  dieciocho: 18,
  diecinueve: 19,
  veinte: 20,
  veintiun: 21,
  veintiuno: 21,
  veintiuna: 21,
  veintidos: 22,
  veintitres: 23,
  veinticuatro: 24,
  veinticinco: 25,
  veintiseis: 26,
  veintisiete: 27,
  veintiocho: 28,
  veintinueve: 29,
  cien: 100,
};
const TENS: Record<string, number> = {
  treinta: 30,
  cuarenta: 40,
  cincuenta: 50,
  sesenta: 60,
  setenta: 70,
  ochenta: 80,
  noventa: 90,
};
/** «y <unidad>» tras una decena: «treinta y cinco». */
const Y_UNIT = '(?: y (?:un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve))?';

/**
 * Número en cifras o en palabras (0–100): «7», «doce», «veinticinco», «treinta y
 * cinco», «cien». Cualquier otra cosa (incluido «veinte y cinco», que no es como
 * se escribe) → null: mejor no entender que entender otro número.
 */
export function spanishNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const s = raw.trim();
  if (/^\d{1,3}$/.test(s)) return Number(s);
  if (s in NUM_WORDS) return NUM_WORDS[s] ?? null;
  const m = /^([a-z]+)(?: y ([a-z]+))?$/.exec(s);
  const tens = m?.[1] ? TENS[m[1]] : undefined;
  if (tens === undefined) return null;
  if (m?.[2] === undefined) return tens;
  const unit = NUM_WORDS[m[2]];
  return unit !== undefined && unit >= 1 && unit <= 9 ? tens + unit : null;
}

/** Paso por defecto de "sube/baja el volumen" sin numero. */
export const DEFAULT_VOLUME_STEP = 3;

/** «a tope» / «al máximo» por voz: 100, el máximo de la tele (decisión de Nico, 30-oct-2026: «a tope es a tope»). */
export const VOLUME_TOPE = 100;
const MAX_VOLUME_STEP = 15;
/** «sube mucho», «baja bastante», «sube un montón»: paso grande, por debajo de MAX_VOLUME_STEP. */
export const BIG_VOLUME_STEP = 10;
const MUCHO = '(?:mucho|muchisimo|bastante|un monton|un mogollon)';
/**
 * «volumen al mínimo»: 1, no 0. A 0 la tele parece silenciada o rota; quien
 * quiera 0 o silencio lo pide («volumen a 0», «silencia la tele»).
 */
export const VOLUME_MINIMO = 1;

const COMPOUND =
  /\by (?:luego |despues )?(?:pon|ponme|abre|abreme|lanza|arranca|sube|subele|baja|bajale|apaga|apagala|enciende|enciendela|silencia|quita|cambia|vuelve|dale|pausa|para|reanuda|cambiala)\b/;

function num(s: string | undefined): number | null {
  return spanishNumber(s);
}

const TV = '(?:(?:la|el) )?(?:tele|tv|television|televisor|pantalla)';

const CUANTOS =
  '(?:\\d{1,3}|un|una|uno|dos|tres|cuatro|cinco|diez|quince|veinte|treinta|cuarenta|media|un par de)';
const HORA = '(?:\\d{1,2}|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)';

/**
 * Hora, plazo o condicion («en 10 minutos», «a las 12», «cuando acabe»,
 * «manana»…): el parser no programa nada, asi que una orden asi NO puede
 * ejecutarse al momento. Devolver null la deja al modelo, que si programa.
 */
const DEFERRED = new RegExp(
  [
    `\\ben ${CUANTOS} ?(?:min|mins|minutos?|seg|segundos?|h|horas?|rato|ratito)\\b`,
    '\\ben (?:un )?(?:rato|ratito|momento|poco)\\b',
    `\\bdurante ${CUANTOS}\\b`,
    '\\bdentro de\\b',
    `\\b(?:a|hasta) (?:las ${HORA}|la una)\\b`,
    '\\bhasta que\\b',
    '\\b(?:cuando|luego|despues|manana)\\b',
    '\\bmas tarde\\b',
    '\\b(?:esta|por la) (?:noche|tarde|manana)\\b',
  ].join('|'),
);

/**
 * Muletillas y vocativo delante de la orden: «oye, sube el volumen», «tele, baja
 * el volumen», «oye tele, apágala». No cambian la orden; se quitan antes de leerla.
 */
/** «cambia a la 2», «pon la tele en la 1», «ponla en la 5», «cámbiala a la tres». */
const cambiaALa = (cap: string): RegExp =>
  new RegExp(
    `^(?:(?:cambia|cambiala|cambialo)(?: (?:(?:la|el) )?(?:tele|tv|television|televisor))? a|(?:pon|ponla|ponlo)(?: (?:(?:la|el) )?(?:tele|tv|television|televisor))? en) la (${cap})$`,
  );
const CAMBIA_A_LA_NUM = cambiaALa('\\d{1,2}');
const CAMBIA_A_LA_PALABRA = cambiaALa('[a-z]+');

const MULETILLA =
  /^(?:(?:oye|oiga|eh|ey|hey|venga|vale|ok|okay) )?(?:(?:tele|tv|television|televisor) )?/;

/** «… en la tele» al final no forma parte de la orden («abre Netflix en la tele»). */
const EN_LA_TELE = / en (?:la |el )?(?:tele|tv|television|televisor|pantalla)$/;

function normalizeOrder(text: string): string {
  return normalizeTvText(text)
    .replace(/\bporfa(?:vor)?\b|\bpor favor\b/g, '')
    .trim()
    .replace(MULETILLA, '')
    .replace(EN_LA_TELE, '');
}

/** Pregunta o queja sobre la tele, no una orden. */
const PREGUNTA =
  /^(?:como|por que|porque|para que|sabes|se puede|es posible)\b|\bse (?:apaga|apago|enciende|encendio|prende|prendio)\b/;

/**
 * Delante del verbo de encender/apagar solo vale una muletilla: «la luz, apágala»
 * habla de otra cosa y no puede apagar la tele.
 */
/** «apágala ya», «enciéndela ahora mismo»: no cambia la orden. */
const YA = '(?: (?:ya|ahora)(?: mismo)?)?';
const ANTES_DEL_VERBO = '^(?:(?:ya|venga|vale|bueno|pues|ahora|no|si|puedes|podrias) )*';

/** La orden lleva hora, plazo o condicion: no es para ejecutarla ya. */
export function tvOrderHasTime(text: string): boolean {
  return DEFERRED.test(normalizeOrder(text));
}

/** Teclas del mando que se piden por voz (todas están en la lista blanca de tools/tv.ts). */
export type TvKeyName = 'BACK' | 'HOME' | 'ENTER' | 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'EXIT';

const ARROWS: Record<string, TvKeyName> = {
  arriba: 'UP',
  abajo: 'DOWN',
  izquierda: 'LEFT',
  derecha: 'RIGHT',
};

const MEDIA_NAMES = {
  pause: 'pausar',
  play: 'reanudar',
  stop: 'parar',
  rewind: 'rebobinar',
  fastForward: 'avanzar rápido',
} as const;

const KEY_NAMES: Record<TvKeyName, string> = {
  BACK: 'volver atrás',
  HOME: 'ir a la pantalla de inicio',
  ENTER: 'pulsar OK',
  UP: 'pulsar arriba',
  DOWN: 'pulsar abajo',
  LEFT: 'pulsar izquierda',
  RIGHT: 'pulsar derecha',
  EXIT: 'salir de la app',
};

export function parseTvCommand(text: string): TvIntent | null {
  const t = normalizeOrder(text);
  if (!t) return null;
  if (DEFERRED.test(t)) return null;
  // Preguntas («¿cómo se apaga la tele?», «¿por qué se apaga?», «¿se puede apagar?»)
  // y quejas («la tele no se enciende»): no son órdenes, van al modelo.
  if (PREGUNTA.test(t)) return null;
  let m: RegExpExecArray | null;

  // «vuelve atrás», «atrás», «pulsa el botón de atrás»: tecla BACK del mando.
  if (
    new RegExp(
      `^(?:(?:vuelve|volver|ve|vete|dale(?: al?)?|pulsa|presiona|toca)(?: (?:hacia|para))? )?(?:(?:el )?boton (?:de )?)?atras(?: (?:en|de) ${TV})?$`,
    ).test(t) ||
    // «volver», «vuelve», «regresa» a secas: también es la tecla atrás.
    new RegExp(`^(?:vuelve|volver|regresa|regresar)(?: (?:en|de) ${TV})?$`).test(t)
  ) {
    return { action: 'key', name: 'BACK' };
  }
  // «ve a inicio», «vuelve al inicio», «pulsa el botón de inicio», «pantalla de inicio»,
  // «home»: tecla HOME del mando (la pantalla de inicio de la tele).
  if (
    new RegExp(
      `^(?:(?:ve|vete|vuelve|volver|ir|regresa|regresar|vamos) (?:a|al|a la) |(?:dale(?: al?)?|pulsa|presiona|toca) (?:(?:el )?boton(?: de)? )?)?(?:(?:la )?(?:pantalla|menu) de )?(?:inicio|home)(?: (?:en|de) ${TV})?$`,
    ).test(t)
  ) {
    return { action: 'key', name: 'HOME' };
  }
  // Mando: «ok», «pulsa ok», «aceptar» (ENTER); «arriba», «pulsa abajo», «flecha izquierda»,
  // «muévete a la derecha» (flechas); «salir», «sal de la app» (EXIT).
  const PULSA =
    '(?:(?:pulsa|presiona|toca|dale(?: al?)?|da(?:le)? a) (?:(?:el )?boton(?: de)? )?)?';
  if (new RegExp(`^${PULSA}(?:ok|okay|aceptar|enter)$`).test(t)) {
    return { action: 'key', name: 'ENTER' };
  }
  m = new RegExp(
    `^(?:${PULSA}(?:la )?(?:flecha (?:de )?)?|(?:muevete|ve|vete|baja|sube) (?:a la |hacia (?:la )?|para )?|a la |hacia (?:la )?)(arriba|abajo|izquierda|derecha)$`,
  ).exec(t);
  if (m?.[1] && ARROWS[m[1]]) {
    return { action: 'key', name: ARROWS[m[1]] as TvKeyName };
  }
  if (
    new RegExp(
      `^(?:${PULSA}salir|sal|sal de (?:la )?(?:app|aplicacion)|cierra (?:la|esta) (?:app|aplicacion))$`,
    ).test(t)
  ) {
    return { action: 'key', name: 'EXIT' };
  }
  // Modo de imagen: «pon la imagen en estándar», «imagen oscura», «pon el modo de imagen juego».
  // Va antes de las rutinas: «la imagen en modo cine» cambia la imagen, «modo cine» es la rutina.
  m = new RegExp(
    `^(?:(?:pon|poner|cambia|cambiar|deja|dejar)(?: (?:la|el))? )?(?:modo de imagen|imagen)(?: (?:en|a|al|de))?(?: modo)? ([a-z ]{2,30}?)(?: (?:en|de) ${TV})?$`,
  ).exec(t);
  if (m?.[1]) {
    const word = m[1].trim();
    const hit = PICTURE_WORDS.find(([re]) => re.test(word));
    if (hit) return { action: 'picture', pictureMode: hit[1] };
    return null;
  }

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
  // «modo juego», «pon el modo deportes», «modo estándar/vivo/eco»: el modo de imagen
  // de la tele. «modo normal» a secas no: es ambiguo y va al modelo. («modo cine»
  // es la rutina de arriba, que además baja luces y abre la app).
  m = new RegExp(
    `^(?:(?:pon|ponme|poner|activa|activar|cambia a|cambiar a)(?: el)? )?modo (juego|juegos|videojuegos|deporte|deportes|futbol|estandar|vivo|viva|vivido|vivida|intenso|intensa|eco|ahorro|ahorro de energia)(?: (?:en|de) ${TV})?$`,
  ).exec(t);
  if (m?.[1]) {
    const word = m[1];
    const hit = PICTURE_WORDS.find(([re]) => re.test(word));
    if (hit) return { action: 'picture', pictureMode: hit[1] };
  }
  // "apaga todo" / "apagalo todo": aviso y apagar la tele.
  if (/^(?:apaga|apagar|apagalo|apagamelo) todo[\s,.!]*$/.test(t)) {
    return { action: 'scene', scene: 'apagar-todo' };
  }

  // Dos ordenes encadenadas («enciende la tele y pon Netflix»): el parser
  // solo ejecuta una, asi que haria la mitad en silencio. Mejor null y que
  // las atienda el modelo (o se pidan por separado).
  if (COMPOUND.test(t)) return null;

  // Estado: preguntas, no ordenes.
  if (
    new RegExp(
      `\\b(?:que (?:esta|estan|hay) (?:viendo|puesto|poniendo)|^que hay$|que (?:estoy|estamos) viendo|que se ve|esta ${TV} (?:encendida|apagada)|esta encendida|esta apagada|estado de ${TV})\\b`,
    ).test(t)
  ) {
    return { action: 'status' };
  }

  // Sonido antes que energia: "apaga el sonido" es silenciar, no apagar la tele.
  if (
    /\b(?:quita|quitale|desactiva) (?:el )?(?:silencio|mute)\b|\b(?:activa|vuelve|devuelve|pon|vuelve a poner) (?:el )?sonido\b|\bdesilencia/.test(
      t,
    )
  ) {
    return { action: 'mute', on: false };
  }
  if (
    /\b(?:silencia|silencio|mutea|mute|calla)\b|\b(?:apaga|quita|quitale|quitalo) (?:el )?(?:sonido|audio|volumen)\b/.test(
      t,
    )
  ) {
    return { action: 'mute', on: true };
  }

  if (
    new RegExp(
      `${ANTES_DEL_VERBO}(?:apaga|apagar|apagame|apagala|apagalo)(?:${YA} ${TV})?${YA}$`,
    ).test(t) ||
    new RegExp(`\\b(?:apaga|apagar) ${TV}\\b`).test(t)
  ) {
    return { action: 'power', on: false };
  }
  if (
    new RegExp(
      `${ANTES_DEL_VERBO}(?:enciende|encender|enciendeme|enciendela|enciendelo|prende|prender|prendela)(?:${YA} ${TV})?${YA}$`,
    ).test(t) ||
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
    /^(?:sube(?:le|lo|la)?(?: (?:el volumen|la tele|la tv))?|pon(?:me)?(?:lo|la)?(?: (?:la tele|la tv))?|(?:pon(?:me)? )?el volumen|volumen) (?:a|al) (?:tope|maximo|full)(?: (?:(?:a|de) )?(?:la )?(?:tele|tv))?$/.test(
      t,
    )
  ) {
    return { action: 'volume', level: VOLUME_TOPE };
  }
  // «bájala a tope», «baja el volumen al máximo»: bajar todo lo posible es el mínimo
  // (VOLUME_MINIMO, 1), nunca 0 ni silencio.
  if (
    /^baja(?:le|lo|la)?(?: (?:el volumen|la tele|la tv))? (?:a|al) (?:tope|maximo)(?: (?:(?:a|de) )?(?:la )?(?:tele|tv))?$/.test(
      t,
    )
  ) {
    return { action: 'volume', level: VOLUME_MINIMO };
  }
  // «volumen al mínimo», «bájalo al mínimo»: VOLUME_MINIMO (1), nunca 0 ni silencio.
  if (
    /^(?:baja(?:le|lo|la)?(?: (?:el volumen|la tele|la tv))?|(?:pon(?:me|le|lo|la)? )?el volumen|volumen|pon(?:lo|la)) (?:a|al) (?:minimo|lo minimo)(?: (?:(?:a|de) )?(?:la )?(?:tele|tv))?$/.test(
      t,
    )
  ) {
    return { action: 'volume', level: VOLUME_MINIMO };
  }

  // Volumen absoluto: "volumen a 20", "pon el volumen al 15", "baja el volumen a 10".
  m =
    new RegExp(`\\bvolumen (?:a|al|en) (\\d{1,3}|[a-z]+${Y_UNIT})\\b`).exec(t) ??
    /^(?:(?:pon|ponme|deja)(?: el)? )?volumen (\d{1,3})$/.exec(t) ??
    // «sube a 30», «baja a 10», «pon la tele a 15», «ponla a 20», «déjala a 12».
    new RegExp(
      `^(?:sube(?:le|lo|la)?|baja(?:le|lo|la)?|(?:pon(?:me)?|deja)(?:lo|la)?(?: ${TV})?) (?:a|al) (\\d{1,3}|[a-z]+${Y_UNIT})$`,
    ).exec(t);
  if (m) {
    const level = num(m[1]);
    if (level !== null && level >= 0 && level <= 100) return { action: 'volume', level };
  }
  // Paso grande: «sube mucho», «bájale bastante», «sube un montón», «baja mucho más el volumen».
  m = new RegExp(
    `^(sube|subele|subelo|subela|baja|bajale|bajalo|bajala)(?: (?:el|al) volumen)? ${MUCHO}(?: mas)?(?: (?:el|al) volumen)?(?: (?:a |de )?${TV})?$`,
  ).exec(t);
  if (m?.[1]) {
    return {
      action: 'volumeStep',
      steps: m[1].startsWith('sube') ? BIG_VOLUME_STEP : -BIG_VOLUME_STEP,
    };
  }
  // «mucho más volumen», «bastante menos volumen», «mucho más alto», «ponla mucho más fuerte».
  if (
    new RegExp(`^${MUCHO} mas (?:de )?volumen$`).test(t) ||
    new RegExp(`\\b${MUCHO} mas (?:alto|alta|fuerte)\\b`).test(t)
  ) {
    return { action: 'volumeStep', steps: BIG_VOLUME_STEP };
  }
  if (
    new RegExp(`^${MUCHO} menos (?:de )?volumen$`).test(t) ||
    new RegExp(`\\b${MUCHO} mas (?:bajo|baja|bajito|bajita|flojo|flojito|suave)\\b`).test(t)
  ) {
    return { action: 'volumeStep', steps: -BIG_VOLUME_STEP };
  }
  // Volumen relativo: "sube el volumen", "baja 5", "sube un poco", "bajale dos",
  // "bajalo un poco", "sube un pelin" (aqui ya se habla de la tele: lo es el volumen).
  // La cantidad puede ir antes de «el volumen»: «baja un poco mas el volumen»,
  // «subele un poco al volumen», «baja dos el volumen».
  m = new RegExp(
    `^(sube|subele|subelo|subela|baja|bajale|bajalo|bajala)(?: el)?(?: volumen)?(?: un (?:poco|poquito|poquitin|pelin|pelito)(?: mas)?| mas| (\\d{1,2}|[a-z]+${Y_UNIT})(?: puntos?| puntitos?| niveles?| veces| vez)?| (un par)(?: de (?:puntos?|puntitos?|niveles?|veces))?)?(?: (?:el|al) volumen)?(?: (?:a|de) ${TV})?$`,
  ).exec(t);
  if (m?.[1]) {
    // «un par (de puntos)»: 2.
    const n = m[3] !== undefined ? 2 : m[2] === undefined ? DEFAULT_VOLUME_STEP : num(m[2]);
    if (n !== null && n > 0) {
      const steps = Math.min(MAX_VOLUME_STEP, n);
      const signed = m[1].startsWith('sube') ? steps : -steps;
      // Se recorta a MAX_VOLUME_STEP por seguridad, pero se dice: «sube 20» no sube 15 en silencio.
      return n > MAX_VOLUME_STEP
        ? { action: 'volumeStep', steps: signed, requested: n }
        : { action: 'volumeStep', steps: signed };
    }
  }
  // «más volumen», «un poco más de volumen», «volumen (para) arriba»; «menos volumen», «volumen abajo».
  if (/^(?:(?:un poco )?mas (?:de )?volumen|volumen (?:para )?arriba)$/.test(t)) {
    return { action: 'volumeStep', steps: DEFAULT_VOLUME_STEP };
  }
  if (/^(?:(?:un poco )?menos (?:de )?volumen|volumen (?:para )?abajo)$/.test(t)) {
    return { action: 'volumeStep', steps: -DEFAULT_VOLUME_STEP };
  }
  // «más alto», «pon la tele más baja», «ponla más fuerte», «más bajito».
  if (/\bmas (?:alto|alta|fuerte)\b/.test(t)) {
    return { action: 'volumeStep', steps: DEFAULT_VOLUME_STEP };
  }
  if (/\bmas (?:bajo|baja|bajito|bajita|flojo|flojito|suave)\b/.test(t)) {
    return { action: 'volumeStep', steps: -DEFAULT_VOLUME_STEP };
  }

  // Canales.
  if (/^cambia (?:de|el) canal$/.test(t)) return { action: 'channel', channel: 'up' };
  if (
    /\b(?:siguiente canal|canal siguiente|sube (?:de |el )?canal|canal arriba|otro canal)\b/.test(t)
  ) {
    return { action: 'channel', channel: 'up' };
  }
  if (/\b(?:canal anterior|anterior canal|baja (?:de |el )?canal|canal abajo)\b/.test(t)) {
    return { action: 'channel', channel: 'down' };
  }
  m =
    /\bcanal (?:numero )?(\d{1,4})\b/.exec(t) ??
    /^(?:pon|ponme) (?:la|el) (\d{1,2})$/.exec(t) ??
    // «cambia al 7», «cámbiala al 24», «cambia la tele al 3».
    new RegExp(`^(?:cambia|cambiala|cambialo)(?: ${TV})? al (\\d{1,2})$`).exec(t) ??
    CAMBIA_A_LA_NUM.exec(t);
  if (m?.[1]) return { action: 'channel', channel: String(Number(m[1])) };
  // "pon la uno", "canal cinco": numero en palabras (solo los de NUM_WORDS).
  m =
    /\bcanal (?:numero )?([a-z]+)$/.exec(t) ??
    /^(?:pon|ponme) (?:la|el) ([a-z]+)$/.exec(t) ??
    CAMBIA_A_LA_PALABRA.exec(t);
  const chWord = m?.[1] && /^[a-z]+$/.test(m[1]) ? spanishNumber(m[1]) : null;
  if (chWord !== null && chWord >= 1) {
    return { action: 'channel', channel: String(chWord) };
  }

  // Entradas.
  m = /\bhdmi ?([1-4])\b/.exec(t);
  if (m) return { action: 'input', input: `hdmi${m[1]}` };

  // Reproduccion.
  // «adelanta», «avance rápido», «rebobina el vídeo», «retrocede»: una pulsación de avance o
  // retroceso. Con segundos («adelanta 10 segundos») va al modelo: la tele no salta exacto.
  const QUE = '(?: (?:la|el) (?:peli|pelicula|serie|cancion|video))?';
  if (new RegExp(`^(?:adelanta|avanza|avance rapido|avanza rapido)${QUE}$`).test(t)) {
    return { action: 'media', command: 'fastForward' };
  }
  if (new RegExp(`^(?:rebobina|retrocede|atrasa)${QUE}$`).test(t)) {
    return { action: 'media', command: 'rewind' };
  }
  if (
    /^(?:pausa|pause|pausala|pausalo|para|deten|detenla|detenlo|pon(?:le)?(?: la)? pausa|(?:dale (?:al?)|pulsa|presiona|toca) (?:pausa|pause)|(?:pausa|para|deten) la (?:peli|pelicula|serie|cancion|video))$/.test(
      t,
    )
  ) {
    return { action: 'media', command: 'pause' };
  }
  if (
    /^(?:play|dale (?:al|a) play|(?:pulsa|presiona|toca) play|dale a reproducir|reanuda|continua|sigue|quita la pausa|(?:reanuda|continua|sigue con) la (?:peli|pelicula|serie|cancion|video))$/.test(
      t,
    )
  ) {
    return { action: 'media', command: 'play' };
  }
  // «stop», «pulsa stop», «dale al stop»: la tecla stop del mando (como en tools/tv.ts media).
  if (/^(?:(?:dale (?:al?)|pulsa|presiona|toca) )?stop$/.test(t)) {
    return { action: 'media', command: 'stop' };
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
      return `${i.steps > 0 ? `subir el volumen ${i.steps}` : `bajar el volumen ${-i.steps}`}${
        i.requested ? ` (pediste ${i.requested}; el máximo de una vez es ${Math.abs(i.steps)})` : ''
      }`;
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
      return MEDIA_NAMES[i.command];
    case 'input':
      return `cambiar a ${i.input.toUpperCase()}`;
    case 'status':
      return 'mirar el estado de la tele';
    case 'scene':
      if (i.scene === 'apagar-todo') return 'apagarlo todo';
      return `activar el modo ${i.scene}${i.appId ? ` con ${i.appId}` : ''}`;
    case 'key':
      return KEY_NAMES[i.name];
    case 'picture':
      return `poner la imagen en modo ${PICTURE_NAMES[i.pictureMode] ?? i.pictureMode}`;
  }
}

/**
 * Aviso extra para la respuesta cuando la orden no se cumple tal cual se pidió
 * (p. ej. «sube 20» se recorta a 15). null si no hay nada que avisar.
 */
export function tvIntentNotice(i: TvIntent): string | null {
  if (i.action === 'volumeStep' && i.requested) {
    const verbo = i.steps > 0 ? 'subir' : 'bajar';
    const hecho = i.steps > 0 ? 'subido' : 'bajado';
    const max = Math.abs(i.steps);
    return `Pediste ${verbo} ${i.requested}, pero de una vez ${i.steps > 0 ? 'subo' : 'bajo'} como mucho ${max}: lo he ${hecho} ${max}.`;
  }
  return null;
}
