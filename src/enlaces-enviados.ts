/**
 * «/biblioteca enlaces» (y «/enlaces»): los enlaces que Asistenta te ha mandado en este chat.
 *
 * La Library de Grok Bot lista también «los enlaces que te mandó en la conversación»
 * (https://docs.x.ai/grok-bot/files-and-results, «Find a page later»: pages, files, apps,
 * images, videos and links). Aquí la noticia, la ficha del piso o el vídeo que te pasó ayer
 * había que buscarlos subiendo por el chat. Se leen de las respuestas ya guardadas en la
 * memoria de sesiones (lo mismo que usa /buscar): nada nuevo se guarda.
 */
import { displayUrl } from './bandeja/captura.js';
import { localDay, localTimeZone } from './datecontext.js';
import { sliceSafe } from './text.js';

export const ENLACES_MAX = 10;

export interface EnlaceEnviado {
  url: string;
  /** Lo que decía al lado (el texto del enlace en Markdown, o la línea sin la URL). */
  etiqueta: string;
  at: number;
}

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/g;
/** Enlaces que no son «algo que te mandé»: el panel local, Tailscale, la red de casa. */
const INTERNO =
  /^(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|\[::1\])$|\.ts\.net$|\.local$/i;

function limpiaUrl(raw: string): string {
  // Puntuación pegada al final de la frase («…en https://x.com/a.») no es de la URL.
  return raw.replace(/[.,;:!?…»”]+$/u, '');
}

function etiquetaDe(linea: string, url: string): string {
  // [El artículo](https://…): el texto del enlace.
  const md = new RegExp(
    `\\[([^\\]]{2,120})\\]\\(${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
  ).exec(linea)?.[1];
  const base = md ?? linea.replace(URL_RE, ' ').replace(/[[\]()*_`#>•-]+/g, ' ');
  const t = base
    .replace(/\s+/g, ' ')
    .replace(/[:·—-]\s*$/, '')
    .trim();
  return t.length > 70 ? `${sliceSafe(t, 69)}…` : t;
}

/**
 * Los enlaces de las respuestas (lo más nuevo primero), sin repetir: si te mandé el mismo
 * dos veces, sale una vez, con la fecha de la última. Sin enlaces internos (panel, Tailscale).
 */
export function enlacesDe(
  turnos: ReadonlyArray<{ text: string; at: number }>,
  max: number = ENLACES_MAX,
): EnlaceEnviado[] {
  const out: EnlaceEnviado[] = [];
  const vistos = new Set<string>();
  for (const t of turnos) {
    for (const linea of t.text.split('\n')) {
      for (const m of linea.matchAll(URL_RE)) {
        const url = limpiaUrl(m[0]);
        let host = '';
        try {
          host = new URL(url).hostname;
        } catch {
          continue;
        }
        if (!host || INTERNO.test(host)) continue;
        const clave = displayUrl(url).replace(/\/$/, '').toLowerCase();
        if (vistos.has(clave)) continue;
        vistos.add(clave);
        out.push({ url, etiqueta: etiquetaDe(linea, m[0]), at: t.at });
        if (out.length >= max) return out;
      }
    }
  }
  return out;
}

function cuando(ms: number, now: number, tz: string): string {
  const d = new Date(ms);
  const hm = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: tz });
  if (localDay(d) === localDay(new Date(now))) return `hoy ${hm}`;
  if (localDay(d) === localDay(new Date(now - 86_400_000))) return `ayer ${hm}`;
  return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', timeZone: tz });
}

function dominio(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** El mensaje: una línea por enlace y un botón «🔗 N» que lo abre (botón-enlace de Telegram). */
export function enlacesVista(
  enlaces: readonly EnlaceEnviado[],
  now: number = Date.now(),
  tz: string = localTimeZone(),
): { text: string; buttons: Array<{ label: string; action: string }> } {
  if (!enlaces.length)
    return {
      text: '🔗 Aún no te he mandado ningún enlace en este chat (o es de antes de que guardara las conversaciones).',
      buttons: [],
    };
  const lineas = enlaces.map((e, i) => {
    const d = dominio(e.url);
    const que =
      e.etiqueta && e.etiqueta.toLowerCase() !== d.toLowerCase() ? `${e.etiqueta} — ` : '';
    return `${i + 1}. ${que}${d} · ${cuando(e.at, now, tz)}\n   ${displayUrl(e.url)}`;
  });
  return {
    text: `🔗 Los enlaces que te he mandado (los ${enlaces.length} últimos):\n${lineas.join('\n')}\n\nToca 🔗 N para abrirlo.`,
    buttons: enlaces
      .map((e, i) => ({ label: `🔗 ${i + 1}`, action: `url:${e.url}` }))
      .filter((b) => /^url:https:\/\/\S+$/.test(b.action) && Buffer.byteLength(b.action) <= 2052),
  };
}
