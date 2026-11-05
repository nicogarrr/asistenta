import { sliceSafe } from '../text.js';

/**
 * Contactos, encuestas y stickers que manda el dueño, como texto que el asistente
 * entiende. Antes los tres recibían «Aún no sé leer…» y había que reescribirlos a
 * mano: el teléfono de un contacto, las opciones de una encuesta reenviada o un
 * sticker 👍 en respuesta a «¿lo envío?». Cada texto empieza por «[», así que nunca
 * se toma por un comando.
 *
 * Puro: se prueba sin bot ni red.
 */

/** Limpia un campo libre de Telegram para que no rompa los corchetes ni las comillas. */
function clean(value: unknown, max = 120): string {
  if (typeof value !== 'string') return '';
  return sliceSafe(value.replace(/[\s[\]«»]+/g, ' ').trim(), max).trim();
}

/** Correos y empresa que trae la vCard de un contacto (Telegram la manda cuando la hay). */
function vcardExtras(vcard: unknown): { emails: string[]; org: string } {
  if (typeof vcard !== 'string' || !vcard) return { emails: [], org: '' };
  const emails: string[] = [];
  let org = '';
  // Las líneas de una vCard pueden venir plegadas (continuación con espacio inicial).
  const lines = vcard.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line
      .slice(0, colon)
      .split(';')[0]
      ?.toUpperCase()
      .replace(/^ITEM\d+\./, '');
    const value = line.slice(colon + 1).trim();
    if (key === 'EMAIL' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && !emails.includes(value)) {
      if (emails.length < 3) emails.push(value);
    } else if (key === 'ORG' && !org) {
      org = clean(value.replace(/;+/g, ' '), 80);
    }
  }
  return { emails, org };
}

/**
 * Un contacto compartido: nombre, teléfono y, si la vCard los trae, correo y empresa.
 * null si no es un contacto o no trae ni nombre ni teléfono.
 */
export function sharedContactText(msg: object): string | null {
  const c = (msg as { contact?: Record<string, unknown> }).contact;
  if (!c || typeof c !== 'object') return null;
  const name = [clean(c.first_name, 60), clean(c.last_name, 60)].filter(Boolean).join(' ');
  const phone = clean(c.phone_number, 40);
  if (!name && !phone) return null;
  const { emails, org } = vcardExtras(c.vcard);
  const parts = [name ? `«${name}»` : '', phone, ...emails, org ? `(${org})` : ''].filter(Boolean);
  return `[Contacto compartido: ${parts.join(' · ')}]`;
}

/**
 * Una encuesta (propia o reenviada): la pregunta y las opciones numeradas, con los
 * votos si ya los tiene y si se puede marcar más de una. null si no es una encuesta.
 */
export function sharedPollText(msg: object): string | null {
  const p = (msg as { poll?: Record<string, unknown> }).poll;
  if (!p || typeof p !== 'object') return null;
  const question = clean(p.question, 300);
  const raw = Array.isArray(p.options) ? (p.options as Array<Record<string, unknown>>) : [];
  const options = raw
    .map((o) => ({ text: clean(o?.text, 100), votes: Number(o?.voter_count) }))
    .filter((o) => o.text);
  if (!question && options.length === 0) return null;
  const anyVotes = options.some((o) => Number.isFinite(o.votes) && o.votes > 0);
  const listed = options
    .map((o, i) => `${i + 1}) ${o.text}${anyVotes ? ` (${o.votes || 0})` : ''}`)
    .join('; ');
  const kind = p.type === 'quiz' ? 'Cuestionario compartido' : 'Encuesta compartida';
  const multi = p.allows_multiple_answers === true ? ', se puede marcar más de una' : '';
  const closed = p.is_closed === true ? ', cerrada' : '';
  return `[${kind}${multi}${closed}: «${question}»${listed ? ` Opciones: ${listed}` : ''}]`;
}

/**
 * Un sticker vale lo que su emoji: un 👍 en respuesta a «¿lo envío?» es un sí. Sin
 * emoji no hay nada que leer y sigue el aviso de siempre (null).
 */
export function stickerText(msg: object): string | null {
  const s = (msg as { sticker?: Record<string, unknown> }).sticker;
  if (!s || typeof s !== 'object') return null;
  const emoji = typeof s.emoji === 'string' ? s.emoji.trim() : '';
  if (!emoji || emoji.length > 16) return null;
  return `[Sticker ${emoji}]`;
}

/** El texto de lo compartido (contacto, encuesta o sticker), o null si no es nada de eso. */
export function sharedKindText(msg: object): string | null {
  return sharedContactText(msg) ?? sharedPollText(msg) ?? stickerText(msg);
}
