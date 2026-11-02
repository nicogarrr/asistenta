import { sliceSafe } from '../text.js';
import { plainInline } from '../utils.js';

/**
 * Las otras conversaciones vivas del mismo chat, en pocas líneas, para la nota de
 * contexto del PRIMER turno de un hilo nuevo. Si Nico dice «y lo de antes mándalo
 * también por correo» y el mensaje abre un hilo aparte (el principal estaba
 * ocupado), ese hilo sabe que existe «lo de antes» y en qué estado está. Va en la
 * nota del turno, nunca en el system prompt, y tiene tope de líneas y de largo.
 */
export interface ThreadSummary {
  key: string;
  chatKey: string;
  name: string;
  label: string;
  active: boolean;
  /** Último uso (ms). */
  createdAt: number;
}

export const OTHER_THREADS_MAX = 5;
const LABEL_MAX = 60;

function ago(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `hace ${h} h` : `hace ${Math.round(h / 24)} d`;
}

export function otherThreadsNote(
  current: { key: string; chatKey: string },
  all: Iterable<ThreadSummary>,
  now: number,
  max = OTHER_THREADS_MAX,
): string {
  const others = [...all]
    .filter((t) => t.chatKey === current.chatKey && t.key !== current.key)
    .sort((a, b) => Number(b.active) - Number(a.active) || b.createdAt - a.createdAt);
  if (!others.length) return '';
  const shown = others.slice(0, Math.max(1, max));
  const lines = shown.map((t) => {
    const name = t.name === 'main' ? 'principal' : t.name;
    const label = sliceSafe(plainInline(t.label).replace(/\s+/g, ' ').trim(), LABEL_MAX);
    const state = t.active ? 'trabajando ahora' : `en espera, ${ago(now - t.createdAt)}`;
    return `- #${plainInline(name)}${label && label !== name ? ` «${label}»` : ''}: ${state}`;
  });
  const rest = others.length - shown.length;
  if (rest > 0) lines.push(`- y ${rest} más`);
  return [
    '<otras_conversaciones>',
    'Este hilo es nuevo. Otras conversaciones de este chat (cada una sigue en su hilo; si el mensaje habla de «lo de antes», puede ser una de estas):',
    ...lines,
    '</otras_conversaciones>',
  ].join('\n');
}

/**
 * Solo en el primer turno del hilo (transcripción vacía: nuevo, o reconstruido tras
 * un reinicio): después ya lo sabe y repetirlo cada turno solo gastaría tokens.
 */
export function otherThreadsForTurn(
  current: { key: string; chatKey: string; transcriptLength: number },
  all: Iterable<ThreadSummary>,
  now: number,
): string {
  if (current.transcriptLength > 0) return '';
  return otherThreadsNote(current, all, now);
}
