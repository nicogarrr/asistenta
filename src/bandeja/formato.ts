/**
 * Textos de la bandeja para Telegram (texto plano, sin Markdown): el aviso al
 * guardar, la ficha de una cosa, la lista de /bandeja y los botones.
 */
import { commandButton } from '../channels/telegram-shared.js';
import { localDay, localTimeZone } from '../datecontext.js';
import { ICS_SOURCE } from '../ics.js';
import { sliceSafe } from '../text.js';
import { type BandejaKind, displayUrl } from './captura.js';
import { eventoLinea } from './evento.js';
import { goodreadsLine } from './goodreads.js';
import { kindleable } from './kindle.js';
import type { BandejaItem } from './store.js';
import { VERDICT_EMOJI, VERDICT_ORDER, verdictLabel } from './veredicto.js';

export type Button = { label: string; action: string };

const KIND_EMOJI: Record<BandejaKind, string> = {
  youtube: '🎬',
  x: '🐦',
  enlace: '🔗',
  pdf: '📄',
  imagen: '🖼️',
  libro: '📚',
  texto: '📝',
};

export function kindEmoji(kind: BandejaKind): string {
  return KIND_EMOJI[kind] ?? '🔗';
}

/** Nombre corto para listas: el título si ya lo hay; si no, el sitio o el fichero. */
export function shortTitle(item: BandejaItem, max = 70): string {
  let t = item.title?.trim();
  if (!t && item.url) {
    try {
      const u = new URL(item.url);
      t = `${u.hostname.replace(/^www\./, '')}${u.pathname.length > 1 ? u.pathname : ''}`;
    } catch {
      t = item.url;
    }
  }
  if (!t) t = item.fileName ?? (item.kind === 'imagen' ? 'captura' : 'sin título');
  return t.length > max ? `${sliceSafe(t, max - 1)}…` : t;
}

/** «11/11» del día local de un instante ISO. */
function diaCorto(iso: string): string {
  const [, m, d] = localDay(new Date(iso)).split('-');
  return `${Number(d)}/${Number(m)}`;
}

/** «📥 Guardado en la bandeja (3 hoy). Te digo esta noche a las 21:30 si merece la pena.» */
export function ackText(
  items: readonly { item: BandejaItem; dup: boolean }[],
  countToday: number,
  hora: string,
  /** El resumen de hoy ya salió: lo guardado ahora va en el de mañana. */
  tomorrow = false,
): string {
  const fresh = items.filter((i) => !i.dup);
  const retry = items.filter((i) => i.dup && i.item.status === 'error');
  const dups = items.length - fresh.length - retry.length;
  const when = tomorrow ? `mañana a las ${hora}` : `a las ${hora}`;
  if (fresh.length === 0 && retry.length > 0)
    return retry.length === 1
      ? `🔁 Eso ya estaba, pero falló (${retry[0]?.item.error ?? 'sin motivo'}): lo vuelvo a mirar. Te digo ${when} si merece la pena.`
      : `🔁 ${retry.length} ya estaban pero fallaron: las vuelvo a mirar. Te digo ${when} si merecen la pena.`;
  // Ya juzgado y ya salió en un resumen (y no es 🔴, que se arrastra): no vuelve a salir,
  // así que «te lo cuento a las 21:30» era falso. Se dice lo que ya se sabe.
  const old = items.length === 1 ? items[0]?.item : undefined;
  if (
    fresh.length === 0 &&
    old?.status === 'listo' &&
    old.verdict &&
    old.verdict !== 'imprescindible' &&
    old.digestedAt
  ) {
    const score = scoreLabel(old);
    return `📥 Eso ya estaba y ya lo miré: ${VERDICT_EMOJI[old.verdict]}${score ? ` ${score}` : ''} «${shortTitle(old, 60)}», en el resumen del ${diaCorto(old.digestedAt)}. /bandeja ficha ${old.id} para verlo otra vez.`;
  }
  if (fresh.length === 0)
    return `📥 Eso ya estaba en la bandeja (${countToday} hoy). Te lo cuento ${when}.`;
  const what =
    fresh.length === 1
      ? `${kindEmoji(fresh[0]?.item.kind ?? 'enlace')} guardado`
      : `${fresh.length} cosas guardadas`;
  const dupNote = dups > 0 ? ` (${dups} ya estaba${dups === 1 ? '' : 'n'})` : '';
  return `📥 ${what} en la bandeja${dupNote} · ${countToday} hoy. Te digo ${when} si merece la pena.`;
}

/** Botones del aviso de guardado: «⚡ Míralo ya» y «🗑️ Quitar» (solo con una cosa). */
export function ackButtons(items: readonly { item: BandejaItem; dup: boolean }[]): Button[] {
  if (items.length !== 1) return [];
  const id = String(items[0]?.item.id);
  return [
    commandButton('⚡ Míralo ya', 'bandeja', id, 'ahora'),
    commandButton('🗑️ Quitar', 'bandeja', id, 'descartar'),
  ].filter((b): b is Button => b !== undefined);
}

/** Los tres botones de una cosa: ✅ visto · ⏭️ mañana · 🗑️ descartar (con su número). */
export function itemButtons(item: BandejaItem, numbered = false): Button[] {
  const id = String(item.id);
  const n = numbered ? ` ${item.id}` : '';
  return [
    commandButton(`✅${n} visto`, 'bandeja', id, 'visto'),
    commandButton(`⏭️${n} mañana`, 'bandeja', id, 'manana'),
    commandButton(`🗑️${n} fuera`, 'bandeja', id, 'descartar'),
  ].filter((b): b is Button => b !== undefined);
}

/** «📖 Al Kindle» de una cosa que se lee (artículo, PDF, post, transcripción), o nada. */
export function kindleButton(item: BandejaItem, numbered = false): Button | undefined {
  if (!kindleable(item)) return undefined;
  return commandButton(
    numbered ? `📖 ${item.id} Kindle` : '📖 Al Kindle',
    'bandeja',
    String(item.id),
    'kindle',
  );
}

/**
 * «🛒 A la compra» de una receta (su página trae la ficha schema.org `Recipe`): apunta sus
 * ingredientes en /compra, como «/compra receta <enlace>» (idea de Muse). Si no, nada.
 */
export function compraButton(item: BandejaItem): Button | undefined {
  if (!item.url || !item.extra.receta || item.extra.receta < 2) return undefined;
  return commandButton('🛒 A la compra', 'bandeja', String(item.id), 'compra');
}

/** «📅 Al calendario» de un evento (su página trae la ficha schema.org `Event`), o nada. */
export function calendarioButton(item: BandejaItem): Button | undefined {
  if (!item.extra.evento?.inicio) return undefined;
  return commandButton('📅 Al calendario', 'bandeja', String(item.id), 'calendario');
}

/**
 * Los botones de la ficha: ✅ ⏭️ 🗑️ y, en su fila, «📖 Al Kindle» si se lee, «🛒 A la
 * compra» si es una receta y «📅 Al calendario» si es un evento (también ya vista).
 */
export function cardButtons(item: BandejaItem): Button[] {
  const extra = [kindleButton(item), compraButton(item), calendarioButton(item)].filter(
    (b): b is Button => b !== undefined,
  );
  if (item.state !== 'pendiente') return extra;
  return [...itemButtons(item), ...extra];
}

/**
 * Dónde está la cosa entera (Nico, 10:58: «donde dices mejor leerlo, debes darme el
 * texto a poder ser en PDF y si no el enlace directo»): siempre hay al menos una línea.
 */
export function linkLines(item: BandejaItem, indent = ''): string[] {
  const out: string[] = [];
  const raw = item.url ?? item.extra.goodreads?.url ?? item.extra.altUrl;
  // Sin ?si=, ?is=, utm_…: se guarda tal cual, pero se enseña limpio.
  const main = raw ? displayUrl(raw) : raw;
  if (main) out.push(`${indent}🔗 ${main}`);
  if (item.extra.altUrl && displayUrl(item.extra.altUrl) !== main)
    out.push(
      `${indent}${item.kind === 'libro' ? '📖' : '▶️'} También: ${displayUrl(item.extra.altUrl)}`,
    );
  if (item.extra.pdfUrl && displayUrl(item.extra.pdfUrl) !== main)
    out.push(`${indent}📄 PDF original: ${displayUrl(item.extra.pdfUrl)}`);
  if (!main && item.fileId)
    out.push(
      `${indent}📎 Es ${item.kind === 'imagen' ? 'la captura' : 'el archivo'} que me mandaste${item.fileName ? ` («${item.fileName}»)` : ''}: búscalo en este chat por la hora.`,
    );
  if (out.length === 0) out.push(`${indent}🔎 Sin enlace: ${shortTitle(item, 80)}`);
  return out;
}

/** ¿La nota salió sin ver el contenido entero (solo descripción o ficha)? Entonces es provisional. */
export function provisional(item: BandejaItem): boolean {
  return (
    item.extra.basis === 'descripcion' || (item.extra.basis === 'ficha' && item.kind !== 'libro')
  );
}

/** «8/10», o «~8/10» si es provisional (sin transcripción). */
export function scoreLabel(item: BandejaItem): string {
  if (item.score === null) return '';
  return `${provisional(item) ? '~' : ''}${item.score}/10`;
}

/** «⚠️ Sin transcripción: juzgado por la descripción (motivo)». */
export function basisLine(item: BandejaItem): string | null {
  const b = item.extra.basis;
  const why = item.extra.basisReason ? ` (${item.extra.basisReason})` : '';
  const media =
    item.kind === 'youtube' || item.kind === 'x' || /podcast/i.test(item.extra.source ?? '');
  if (b === 'descripcion')
    return media
      ? `⚠️ Sin transcripción: juzgado por la descripción${why}`
      : `⚠️ Con poco texto: juzgado por la descripción${why}`;
  if (b === 'transcripcion' && item.extra.heardMin)
    return `⚠️ Solo oí los primeros ${item.extra.heardMin} min (la transcripción se cortó por tiempo): la nota es de esa parte`;
  if (b === 'ficha' && item.kind !== 'libro')
    return media
      ? `⚠️ Sin transcripción: juzgado solo por la ficha${why}`
      : `⚠️ Sin abrir: juzgado solo por el título${why}`;
  return null;
}

function metaLine(item: BandejaItem): string {
  const parts: string[] = [];
  if (item.extra.author) parts.push(`👤 ${item.extra.author}`);
  if (item.costLabel) parts.push(item.costLabel);
  if (item.extra.source && !['captura', 'nota'].includes(item.extra.source))
    parts.push(item.extra.source);
  return parts.join(' · ');
}

/** «📅 jueves 20 nov, 10:00 · IFEMA» si la página es de un evento (su ficha schema.org `Event`). */
export function eventLine(item: BandejaItem, now: Date = new Date(), tz?: string): string | null {
  const ev = item.extra.evento;
  if (!ev?.inicio) return null;
  return eventoLinea(ev, tz ?? localTimeZone(), now);
}

/** La ficha completa de una cosa ya procesada (o por qué no lo está). */
export function cardText(item: BandejaItem, now: Date = new Date()): string {
  const head = `#${item.id} ${kindEmoji(item.kind)} ${shortTitle(item, 120)}`;
  if (item.state === 'descartado' && item.status === 'listo' && !item.verdict)
    return [head, `ℹ️ ${item.error ?? 'quitada'}.`].join('\n');
  if (item.status === 'error')
    return [head, `⚠️ No pude juzgarlo: ${item.error ?? 'error'}.`, ...linkLines(item)].join('\n');
  if (item.status !== 'listo' || !item.verdict)
    return `${head}\n⏳ Aún lo estoy procesando. Te lo digo en cuanto lo tenga.`;
  const lines = [
    // Una invitación .ics no se juzga (no hay nota): se dice lo que es.
    item.extra.source === ICS_SOURCE
      ? item.extra.evento
        ? '📅 Invitación de calendario'
        : '❌ Cancelación de un evento'
      : `${verdictLabel(item.verdict, item.kind, item.extra.source)} · ${scoreLabel(item) || '?/10'}${provisional(item) ? ' (provisional)' : ''}`,
    head,
  ];
  const meta = metaLine(item);
  if (meta) lines.push(meta);
  const cuando = eventLine(item, now);
  if (cuando) lines.push(cuando);
  const gr = goodreadsLine(item.extra.goodreads);
  if (gr) lines.push(gr);
  if (item.extra.publicRating) lines.push(item.extra.publicRating);
  const basis = basisLine(item);
  if (basis) lines.push(basis);
  if (item.reason) lines.push(`Por qué: ${item.reason}`);
  if (item.ideas.length) {
    lines.push('', '💡 Ideas clave:');
    for (const idea of item.ideas) lines.push(`• ${idea}`);
  }
  if (item.extra.tags?.length) lines.push(`🏷️ ${item.extra.tags.join(', ')}`);
  if (item.carried > 0)
    lines.push(`⏰ Pendiente desde hace ${item.carried} día${item.carried === 1 ? '' : 's'}`);
  lines.push(...linkLines(item));
  return lines.join('\n');
}

function statusMark(item: BandejaItem): string {
  if (item.state === 'visto') return '✅';
  if (item.status === 'error') return '⚠️';
  if (item.status !== 'listo' || !item.verdict) return '⏳';
  return VERDICT_EMOJI[item.verdict];
}

/** Ordena 🔴 → 🟡 → ⚪ → sin veredicto; dentro, por nota y luego por llegada. */
export function byVerdict(a: BandejaItem, b: BandejaItem): number {
  const rank = (i: BandejaItem) => (i.verdict ? VERDICT_ORDER.indexOf(i.verdict) : 3);
  return rank(a) - rank(b) || (b.score ?? 0) - (a.score ?? 0) || a.id - b.id;
}

/** /bandeja: lo de hoy (y lo imprescindible que se arrastra), una línea por cosa. */
export function listText(
  today: readonly BandejaItem[],
  carried: readonly BandejaItem[],
  hora: string,
): string {
  if (today.length === 0 && carried.length === 0)
    return [
      '📥 La bandeja de hoy está vacía.',
      'Mándame enlaces (YouTube, X, artículos), PDFs, capturas o «libro: título» sin más texto y los guardo. A las ' +
        `${hora} te digo qué merece la pena.`,
    ].join('\n');
  const lines = [`📥 Bandeja de hoy: ${today.length} cosa${today.length === 1 ? '' : 's'}`];
  for (const it of [...today].sort(byVerdict)) {
    const score = it.score ? ` ${scoreLabel(it)}` : '';
    lines.push(
      `${statusMark(it)} #${it.id} ${kindEmoji(it.kind)} ${shortTitle(it, 60)}${score}${it.costLabel ? ` · ${it.costLabel.replace(/^\S+\s/, '')}` : ''}`,
    );
  }
  if (carried.length) {
    lines.push('', `⏰ Imprescindibles pendientes de otros días: ${carried.length}`);
    for (const it of carried.slice(0, 8))
      lines.push(`🔴 #${it.id} ${kindEmoji(it.kind)} ${shortTitle(it, 60)}`);
  }
  lines.push(
    '',
    `Ficha de una: /bandeja ver N · resumen ahora: /bandeja resumen · a las ${hora} te llega solo.`,
  );
  return lines.join('\n');
}
