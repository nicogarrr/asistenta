/**
 * Atajo sin modelo para órdenes de tele claras en un mensaje normal (texto o
 * nota de voz), no solo con /tv.
 *
 * Antes «baja el volumen de la tele» o, navegando, «abajo» y «atrás» pasaban
 * siempre por el modelo en la nube: dos vueltas (herramienta + respuesta),
 * unos 4–8 s más por orden. Aquí se hacen al momento con el mismo parser y la
 * misma tool que /tv (src/tv/tv-chat-command.ts).
 *
 * Conservador a propósito: «abre youtube», «apaga» u «ok» pueden ser del PC o
 * una respuesta a otra cosa. Solo se ataja cuando:
 * - el mensaje nombra la tele («…de la tele», «en la tv») o una tele conocida
 *   por su nombre («en el salón»), o
 * - hace menos de 3 min hubo otra orden de tele (estás navegando), y no es un
 *   «ok/vale/sí» suelto ni abrir una app que no es de tele, o
 * - es «pon X en YouTube/Netflix» y hay una tele configurada.
 * Nunca con hora o condición («a las 9», «cuando…»), ni si nombra el PC.
 */
import { APP_ALIASES, normalizeTvText } from './apps.js';
import { parseTvCommand, searchTextAsWritten, type TvIntent, tvOrderHasTime } from './natural.js';
import { extractTvTarget, withoutTvPlace } from './target.js';

/** Ventana tras una orden de tele en la que lo siguiente se entiende como de la tele. */
export const TV_CONTEXT_MS = 3 * 60_000;
const FAST_MAX_LEN = 80;
const MENTIONS_TV = /\b(tele|televisi[oó]n|tv)\b/i;
const URL_IN_TEXT = /https?:\/\/\S+/g;
const QUOTED = /[«"“][^«»"“”\r\n]{1,80}[»"”]/;
const NAMES_SEARCH_APP = /\b(you ?tube|netflix)\b/i;
const NAMES_PC =
  /\b(ordenador|pc|port[aá]til|escritorio|windows|m[oó]vil|iphone|chrome|navegador|correo|telegram)\b/i;
const BARE_REPLY =
  /^\s*(ok|okay|okey|vale|s[ií]|no|dale|venga|va|bien|perfecto|genial|gracias|para|stop)\s*[.!¡?¿]*\s*$/i;

export interface TvFastPathInput {
  text: string;
  now: number;
  /** Hora de la última orden de tele hecha (cualquier vía), o null. */
  lastTvOrderAt: number | null;
  /** Nombres de las teles conocidas («salón», «dormitorio»). */
  tvNames?: readonly string[];
  /** Hay una tele configurada (activa o en el registro). */
  hasTv?: boolean;
}

/** «pon …», «ponme …», «reproduce …»: poner algo a ver, no buscarlo en el PC. */
const PLAY_VERB = /^\s*(?:pon|ponme|reproduce|reproduceme)\b/i;

function namesKnownTv(text: string, names: readonly string[]): boolean {
  const t = ` ${normalizeTvText(text)} `;
  return names.some((n) => {
    const nn = normalizeTvText(n);
    return nn.length >= 3 && t.includes(` ${nn} `);
  });
}

/** «pon netflix en el salón» → «pon netflix» (para reconocer la orden, no para elegir la tele). */
function withoutTvName(text: string, names: readonly string[]): string {
  // El enlace se aparta antes de normalizar: el id de un vídeo distingue mayúsculas.
  const link = text.match(URL_IN_TEXT)?.[0];
  if (link)
    return withoutTvName(text.replace(link, ' zzenlacezz '), names).replace('zzenlacezz', link);
  // Igual con un título entre comillas: «Mañana» sin comillas se leería como hora.
  const quoted = QUOTED.exec(text)?.[0];
  if (quoted)
    return withoutTvName(text.replace(quoted, ' zztitulocomillaszz '), names).replace(
      'zztitulocomillaszz',
      quoted,
    );
  let out = normalizeTvText(text);
  for (const n of names) {
    const nn = normalizeTvText(n);
    if (nn.length < 3) continue;
    const esc = nn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(
      new RegExp(`\\s*\\b(?:en|de|del)\\s+(?:(?:el|la|los|las)\\s+)?${esc}\\b`, 'g'),
      '',
    );
  }
  return out.replace(/\s{2,}/g, ' ').trim();
}

/**
 * Lo buscado tal y como lo escribió el dueño. Quitar el nombre de la tele
 * normaliza el texto (sin tildes, en minúsculas): «pon en YouTube Peña en el
 * salón» buscaba «pena», y un enlace de YouTube perdía las mayúsculas del id.
 */
function asWritten(intent: TvIntent, original: string): TvIntent {
  if (intent.action !== 'search') return intent;
  const link = original.match(URL_IN_TEXT)?.[0];
  if (link && /^https?\b/.test(intent.text)) return { ...intent, text: link };
  return { ...intent, text: searchTextAsWritten(original, intent.text) };
}

/** La orden de tele a hacer al momento, o null si debe ir al modelo como siempre. */
export function tvFastPathIntent(input: TvFastPathInput): TvIntent | null {
  const text = input.text.trim();
  // Un enlace cuenta como una palabra: «pon en YouTube <enlace con &list=…>»
  // pasaba del tope y, con «t=90s», se leía como una hora.
  const sansUrl = text.replace(URL_IN_TEXT, ' enlace ');
  if (!text || sansUrl.length > FAST_MAX_LEN || /[\r\n]/.test(text)) return null;
  if (NAMES_PC.test(sansUrl) || tvOrderHasTime(sansUrl)) return null;
  const names = input.tvNames ?? [];
  if (namesKnownTv(sansUrl, names)) {
    // La tele la elige luego la tool por su nombre; aquí solo se mira si es una orden.
    const intent = parseTvCommand(withoutTvName(text, names));
    if (intent) return asWritten(intent, text);
    // «enciende la del dormitorio»: quitar solo «del dormitorio» deja «enciende
    // la», que no es una orden; la tool lo entiende como «enciende la tele».
    const byName = extractTvTarget(
      text,
      names.map((name, i) => ({ host: `tv-${i}`, name, clientKey: '', secure: '1' as const })),
    );
    if (byName.tv && !byName.ask) {
      const named = parseTvCommand(byName.text);
      if (named) return asWritten(named, text);
    }
  }
  const intent = parseTvCommand(text) ?? parseTvCommand(withoutTvPlace(text));
  if (!intent) return null;
  if (MENTIONS_TV.test(text)) return intent;
  // «pon en YouTube Bailando», «pon el tráiler de Dune en Netflix»: con una
  // tele configurada y sin nombrar el PC, es para verlo en la tele. Antes iba
  // al modelo y en la tele solo podía abrir la app de YouTube, sin buscar.
  // «busca X en YouTube» sin más puede ser del navegador: sigue al modelo.
  // Un enlace solo («pon https://youtu.be/…») sin «YouTube» ni «tele» puede ser del PC.
  if (
    intent.action === 'search' &&
    input.hasTv &&
    PLAY_VERB.test(text) &&
    NAMES_SEARCH_APP.test(sansUrl)
  ) {
    return intent;
  }
  const recent =
    input.lastTvOrderAt !== null &&
    input.now >= input.lastTvOrderAt &&
    input.now - input.lastTvOrderAt < TV_CONTEXT_MS;
  if (!recent || BARE_REPLY.test(text)) return null;
  if (intent.action === 'launch' && APP_ALIASES[normalizeTvText(intent.appId)] === undefined) {
    return null;
  }
  return intent;
}
