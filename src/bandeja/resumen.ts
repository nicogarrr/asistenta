/**
 * El resumen de la noche de la bandeja (21:30 por defecto, Europe/Madrid): un solo
 * mensaje con lo de hoy ordenado 🔴 → 🟡 → ⚪, la paja en una línea, el tiempo que
 * cuesta lo imprescindible y tres botones por cosa (✅ visto · ⏭️ mañana · 🗑️ fuera).
 *
 * Qué entra en el resumen del día D (pendientes, sin descartar):
 * - lo guardado el día D (o pasado a D con «⏭️ Mañana»);
 * - lo 🔴 imprescindible de días anteriores que sigue sin ver (se arrastra y se marca
 *   «⏰ pendiente desde hace N días»);
 * - lo que nunca salió en un resumen (p. ej. el PC estaba apagado a esa hora).
 * Lo 🟡/⚪ de días anteriores que ya salió en su resumen no vuelve: ya tuvo su noche.
 *
 * Los domingos, detrás, «🏆 Lo mejor de la semana».
 */
import { commandButton } from '../channels/telegram-shared.js';
import { localDay, wallClock, zonedTime } from '../datecontext.js';
import { sliceSafe } from '../text.js';
import {
  type Button,
  basisLine,
  byVerdict,
  eventLine,
  itemButtons,
  kindEmoji,
  kindleButton,
  linkLines,
  scoreLabel,
  shortTitle,
} from './formato.js';
import { goodreadsLine } from './goodreads.js';
import { minutesLabel } from './procesar.js';
import type { BandejaItem, BandejaStore } from './store.js';
import { verdictLabel } from './veredicto.js';

export const DEFAULT_BANDEJA_HORA = '21:30';
/** Cosas con botones en un resumen (Telegram: 100 botones; el móvil, bastante menos). */
export const MAX_DIGEST_BUTTON_ITEMS = 10;
/** Cosas listadas en un resumen; el resto, «y N más» con /bandeja. */
export const MAX_DIGEST_ITEMS = 15;
/**
 * Cosas ⚪ (paja) con «📅 N calendario» / «🛒 N compra» en el resumen: la paja no lleva
 * ✅/⏭️/🗑️ (para eso está 🧹), pero un evento o una receta valen por lo práctico aunque
 * su contenido sea paja, y el botón ahorra abrir la ficha.
 */
export const MAX_DIGEST_CHAFF_ACTION_ITEMS = 4;

/**
 * Minutos de audio que transcribe la bandeja por cosa (PA_BANDEJA_MAX_MIN, 180 por
 * defecto): va en segundo plano, así que llega a un podcast entero, no solo al
 * principio (con 6 min, el e2e juzgó un panel de 1 h por sus agradecimientos).
 */
export function bandejaMaxMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PA_BANDEJA_MAX_MIN);
  return Number.isFinite(n) && n >= 5 ? Math.min(600, Math.round(n)) : 180;
}

/** «21:30», «9:05», «22» → «HH:MM»; null si no es una hora. */
export function parseHora(raw: string | undefined | null): string | null {
  const m = /^\s*(\d{1,2})(?:[:.h](\d{2}))?\s*$/i.exec(raw ?? '');
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2] ?? '0');
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** La hora del resumen: la de /bandeja hora, si no PA_BANDEJA_HORA, si no 21:30. */
export function digestHora(store: BandejaStore, env: NodeJS.ProcessEnv = process.env): string {
  return parseHora(store.getMeta('hora')) ?? parseHora(env.PA_BANDEJA_HORA) ?? DEFAULT_BANDEJA_HORA;
}

/** Día local siguiente a `day` (YYYY-MM-DD). */
export function nextDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return localDay(zonedTime(y ?? 1970, m ?? 1, (d ?? 1) + 1, 12, 0));
}

/**
 * El día al que va «⏭️ Mañana»: el siguiente al de hoy; de madrugada (antes de las 6),
 * el resumen que se está mirando es el de anoche, así que «mañana» es hoy.
 */
export function tomorrowFor(now: Date): string {
  const today = localDay(now);
  return wallClock(now).hour < 6 ? today : nextDay(today);
}

/** Lo que entra en el resumen del día `day` (ver cabecera). */
export function digestItems(store: BandejaStore, chatId: string, day: string): BandejaItem[] {
  return store
    .pending(chatId)
    .filter((it) => it.day <= day)
    .filter((it) => it.day === day || it.verdict === 'imprescindible' || !it.digestedAt)
    .sort(byVerdict);
}

function oneLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${sliceSafe(t, max - 1)}…` : t;
}

const WEEKDAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const wd = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay();
  return `${WEEKDAYS[wd]} ${d}-${['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'][(m ?? 1) - 1]}`;
}

export interface Digest {
  text: string;
  buttons: Button[];
  /**
   * Ids que salieron de verdad en el texto (se marcan como resumidos). Lo que quedó en
   * «…y N más» o se estaba procesando no: antes un 🟡 que no cabía (más de 15) se daba por
   * resumido sin haberlo visto y no volvía a salir ninguna noche.
   */
  ids: number[];
  empty: boolean;
}

/** El mensaje del resumen del día. */
export function composeDigest(
  items: readonly BandejaItem[],
  day: string,
  now: Date = new Date(),
): Digest {
  if (items.length === 0)
    return { text: '📥 Hoy no guardaste nada en la bandeja.', buttons: [], ids: [], empty: true };
  const red = items.filter((i) => i.status === 'listo' && i.verdict === 'imprescindible');
  const yellow = items.filter((i) => i.status === 'listo' && i.verdict === 'ideas');
  const chaff = items.filter((i) => i.status === 'listo' && i.verdict === 'paja');
  const waiting = items.filter((i) => i.status === 'nuevo' || i.status === 'procesando');
  const failed = items.filter((i) => i.status === 'error');
  const carried = red.filter((i) => i.day < day || i.carried > 0);
  const lines: string[] = [
    `📥 Tu bandeja (${dayLabel(day)}): ${items.length} cosa${items.length === 1 ? '' : 's'} · ${red.length} 🔴 · ${yellow.length} 🟡 · ${chaff.length} ⚪`,
  ];
  if (carried.length)
    lines.push(
      `⏰ ${carried.length} imprescindible${carried.length === 1 ? '' : 's'} pendiente${carried.length === 1 ? '' : 's'} de otros días`,
    );
  const redMin = red.reduce((s, i) => s + (i.costMin ?? 0), 0);
  if (redMin > 0) lines.push(`⏱️ Lo imprescindible te lleva ~${minutesLabel(redMin)}.`);
  const chaffMin = chaff.reduce((s, i) => s + (i.costMin ?? 0), 0);
  if (chaffMin >= 5) lines.push(`🧹 Te ahorro ~${minutesLabel(chaffMin)} de paja.`);
  const withButtons: BandejaItem[] = [];
  /** Lo que de verdad sale en el texto (lo demás no cuenta como resumido). */
  const shownIds: number[] = [];
  let shown = 0;
  const section = (title: string, list: readonly BandejaItem[], ideas: number) => {
    if (!list.length) return;
    lines.push('', title);
    for (const it of list) {
      if (shown >= MAX_DIGEST_ITEMS) return;
      shown++;
      shownIds.push(it.id);
      const tail = [scoreLabel(it), it.costLabel?.replace(/^\S+\s/, '') ?? '']
        .filter(Boolean)
        .join(' · ');
      const pend = it.day < day || it.carried > 0 ? ' ⏰' : '';
      lines.push(
        `#${it.id} ${kindEmoji(it.kind)} ${shortTitle(it, 80)}${tail ? ` — ${tail}` : ''}${pend}`,
      );
      if (it.verdict === 'imprescindible')
        lines.push(
          `   ${verdictLabel(it.verdict, it.kind, it.extra.source).replace(/^🔴 Imprescindible: /, '👉 ')}`,
        );
      // La fecha del evento (congreso, webinar, junta): se ve sin abrir la ficha.
      const cuando = eventLine(it, now);
      if (cuando) lines.push(`   ${cuando}`);
      if (esReceta(it))
        lines.push(
          `   🛒 Receta: ${it.extra.receta} ingredientes (🛒 ${it.id} compra los apunta en /compra)`,
        );
      if (it.reason) lines.push(`   ${oneLine(it.reason, 200)}`);
      for (const idea of it.ideas.slice(0, ideas)) lines.push(`   • ${oneLine(idea, 160)}`);
      const gr = goodreadsLine(it.extra.goodreads);
      if (gr) lines.push(`   ${gr}`);
      const basis = basisLine(it);
      if (basis) lines.push(`   ${basis}`);
      if (it.extra.tags?.length) lines.push(`   🏷️ ${it.extra.tags.join(', ')}`);
      lines.push(...linkLines(it, '   '));
      if (withButtons.length < MAX_DIGEST_BUTTON_ITEMS) withButtons.push(it);
    }
  };
  section('🔴 Imprescindible: dale tiempo entero', red, 2);
  section('🟡 Ideas buenas: con esto basta', yellow, 3);
  /** Paja con «📅 / 🛒» (sin ✅/⏭️/🗑️: para eso está 🧹). */
  const chaffActions: BandejaItem[] = [];
  if (chaff.length) {
    // La paja, recogida: una línea por cosa, con su enlace por si acaso.
    lines.push('', `⚪ Paja (${chaff.length}), la quito con 🧹:`);
    for (const it of chaff.slice(0, 8)) {
      shownIds.push(it.id);
      lines.push(
        `#${it.id} ${shortTitle(it, 40)} ${linkLines(it)[0]?.replace(/^🔗 /, '🔗') ?? ''}`.trim(),
      );
      const cuando = eventLine(it, now);
      const futuro = !!cuando && !cuando.endsWith('(ya pasó)');
      if (futuro) lines.push(`   ${cuando}`);
      if (chaffActions.length < MAX_DIGEST_CHAFF_ACTION_ITEMS && (futuro || esReceta(it)))
        chaffActions.push(it);
    }
    if (chaff.length > 8) lines.push(`…y ${chaff.length - 8} más`);
  }
  if (waiting.length)
    lines.push(
      '',
      `⏳ Aún procesando (${waiting.length}): ${waiting.map((i) => `#${i.id} ${shortTitle(i, 40)}`).join(', ')}`,
    );
  if (failed.length) {
    lines.push('', `⚠️ No pude juzgar (${failed.length}):`);
    for (const it of failed.slice(0, 5)) {
      shownIds.push(it.id);
      lines.push(
        `#${it.id} ${shortTitle(it, 50)} — ${it.error ?? 'error'}`,
        ...linkLines(it, '   '),
      );
    }
  }
  const rest = red.length + yellow.length - shown;
  if (rest > 0) lines.push('', `…y ${rest} más: /bandeja`);
  const buttons: Button[] = [];
  for (const it of withButtons) buttons.push(...itemButtons(it, true));
  // «📅 / 🛒» también de la paja que sea un evento o una receta (📖 no: casi toda la paja
  // se puede leer, y cuatro «📖 Kindle» de paja serían ruido).
  const actionable = [...withButtons, ...chaffActions];
  // «📖 N Kindle» de lo que se lee, detrás (de tres en tres: no descuadra las filas de arriba).
  for (const it of withButtons) {
    const kb = kindleButton(it, true);
    if (kb) buttons.push(kb);
  }
  // «📅 N calendario» de lo que es un evento que aún no ha pasado (enseña qué apunta; no apunta).
  for (const it of actionable) {
    const cuando = eventLine(it, now);
    if (!cuando || cuando.endsWith('(ya pasó)')) continue;
    const b = commandButton(`📅 ${it.id} calendario`, 'bandeja', String(it.id), 'calendario');
    if (b) buttons.push(b);
  }
  // «🛒 N compra» de lo que es una receta (con su ficha Recipe): sus ingredientes a /compra,
  // como el «🛒 A la compra» de la ficha, sin tener que abrirla.
  for (const it of actionable) {
    if (!esReceta(it)) continue;
    const b = commandButton(`🛒 ${it.id} compra`, 'bandeja', String(it.id), 'compra');
    if (b) buttons.push(b);
  }
  if (chaff.length) {
    const b = chaffButton(day);
    if (b) buttons.push(b);
  }
  return { text: lines.join('\n'), buttons, ids: shownIds, empty: false };
}

/** Una receta con su ficha `Recipe` (2+ ingredientes), como el «🛒 A la compra» de la ficha. */
function esReceta(it: BandejaItem): boolean {
  return !!it.url && !!it.extra.receta && it.extra.receta >= 2;
}

/** «🧹 Quitar la paja»: descarta todo lo ⚪ pendiente hasta ese día. */
function chaffButton(day: string): Button | undefined {
  return commandButton('🧹 Quitar la paja', 'bandeja', day.replace(/-/g, ''), 'paja');
}

/**
 * Tras mandar el resumen: lo 🔴 sin ver pasa al día siguiente (se arrastra), y todo lo
 * que salió queda marcado como resumido.
 */
export function afterDigest(
  store: BandejaStore,
  items: readonly BandejaItem[],
  day: string,
  now: Date,
  /** Los que salieron en el texto (Digest.ids); sin esto, todos los de `items`. */
  shown?: readonly number[],
): void {
  // Lo que aún se procesaba no cuenta como resumido: saldrá en el siguiente con su veredicto.
  // Lo que no cupo en el texto, tampoco.
  const inText = shown ? new Set(shown) : null;
  store.markDigested(
    items
      .filter((i) => i.status === 'listo' || i.status === 'error')
      .filter((i) => !inText || inText.has(i.id))
      .map((i) => i.id),
    now,
  );
  const next = nextDay(day);
  for (const it of items) {
    if (it.state === 'pendiente' && it.verdict === 'imprescindible') store.moveTo(it.id, next);
  }
}

/** «🏆 Lo mejor de la semana» (domingos): lo mejor por nota y cuánto quedó por ver. */
export function composeWeekly(items: readonly BandejaItem[]): string | null {
  const done = items.filter((i) => i.status === 'listo' && i.verdict && i.state !== 'descartado');
  if (items.length === 0) return null;
  const red = done.filter((i) => i.verdict === 'imprescindible');
  const seen = red.filter((i) => i.state === 'visto').length;
  const chaff = items.filter((i) => i.verdict === 'paja');
  const chaffMin = chaff.reduce((s, i) => s + (i.costMin ?? 0), 0);
  const lines = [
    `🏆 Tu semana en la bandeja: ${items.length === 1 ? '1 cosa guardada' : `${items.length} cosas guardadas`} · ${red.length} 🔴 (${seen} vista${seen === 1 ? '' : 's'}) · ${done.filter((i) => i.verdict === 'ideas').length} 🟡 · ${chaff.length} ⚪`,
  ];
  if (chaffMin >= 5)
    lines.push(`🧹 Paja quitada: ~${minutesLabel(chaffMin)} que no tuviste que gastar.`);
  const best = [...done]
    .filter((i) => i.verdict !== 'paja')
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.id - b.id)
    .slice(0, 5);
  if (best.length) {
    lines.push('', 'Lo mejor:');
    best.forEach((it, n) => {
      const mark = it.state === 'visto' ? '✅' : '👀 sin ver';
      lines.push(
        `${n + 1}. ${kindEmoji(it.kind)} ${shortTitle(it, 70)} — ${it.score}/10 · ${mark}`,
      );
      if (it.ideas[0]) lines.push(`   • ${oneLine(it.ideas[0], 160)}`);
      lines.push(...linkLines(it, '   '));
    });
  }
  const pend = red.filter((i) => i.state === 'pendiente');
  if (pend.length)
    lines.push(
      '',
      `⏰ Te quedan ${pend.length} imprescindible${pend.length === 1 ? '' : 's'} sin ver: siguen en el resumen de cada noche.`,
    );
  return lines.join('\n');
}

export interface DigestDeps {
  store: BandejaStore;
  now: () => Date;
  /** Chat del dueño (fail-closed: sin dueño no sale nada). */
  owner: () => string | null;
  send: (chatId: string, text: string, buttons: Button[]) => Promise<boolean>;
  /** Nota de voz del resumen (PA_BANDEJA_VOZ=1); se llama después del texto, sin esperarla. */
  speak?: (chatId: string, text: string) => Promise<void>;
  /** Adjunta el PDF original de lo 🔴 que lo tenga (descarga directa, tal cual). */
  sendPdf?: (chatId: string, url: string, name: string) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  warn?: (msg: string, data?: Record<string, unknown>) => void;
}

export type DigestStatus = 'not-due' | 'no-owner' | 'empty' | 'sent' | 'send-failed' | 'busy';

let inFlight = false;

/** Entre un intento fallido del resumen y el siguiente. */
export const DIGEST_RETRY_MS = 10 * 60_000;
/** Intentos por noche antes de dejarlo para el resumen de mañana. */
export const DIGEST_MAX_TRIES = 3;

function digestFail(store: BandejaStore, day: string): { n: number; at: number } | null {
  try {
    const v = JSON.parse(store.getMeta('digest_fail') ?? 'null') as {
      day?: unknown;
      n?: unknown;
      at?: unknown;
    } | null;
    if (!v || v.day !== day || typeof v.n !== 'number' || typeof v.at !== 'number') return null;
    return { n: v.n, at: v.at };
  } catch {
    return null;
  }
}

function minutesOfDay(hora: string): number {
  const [h, m] = hora.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Días después del domingo en que aún se manda el repaso de la semana que no salió (PC
 * apagado el domingo a la hora del resumen, o Telegram fallando con ese mensaje). Más tarde
 * ya es una semana vieja y no se manda.
 */
export const WEEKLY_CATCHUP_DAYS = 2;

/** El domingo de la semana de `day` (el mismo día si ya es domingo). */
function sundayOf(day: string, weekday: number): string {
  // Aritmética de calendario sobre el mediodía UTC del día local (sin zona ni horario de
  // verano de por medio); se formatea a mano.
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - weekday);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function weeklyFail(store: BandejaStore, sunday: string): { n: number; at: number } | null {
  try {
    const v = JSON.parse(store.getMeta('weekly_fail') ?? 'null') as {
      sunday?: unknown;
      n?: unknown;
      at?: unknown;
    } | null;
    if (!v || v.sunday !== sunday || typeof v.n !== 'number' || typeof v.at !== 'number')
      return null;
    return { n: v.n, at: v.at };
  } catch {
    return null;
  }
}

/**
 * «🏆 Tu semana en la bandeja», una vez por semana, ya pasada la hora del resumen. Antes solo
 * salía si el resumen corría EN domingo y se daba por enviado aunque Telegram fallara: con el
 * PC apagado el domingo a las 21:30 la semana se perdía. Ahora sale con el primer resumen
 * desde ese domingo (hasta WEEKLY_CATCHUP_DAYS después) y, si falla, se reintenta como el
 * resumen (cada 10 min, 3 veces).
 */
async function sendWeeklyIfDue(
  deps: DigestDeps,
  chatId: string,
  day: string,
  weekday: number,
  now: Date,
): Promise<void> {
  const sunday = sundayOf(day, weekday);
  if ((deps.store.getMeta('last_weekly_day') ?? '') >= sunday) return;
  const late = Math.round(
    (Date.parse(`${day}T12:00:00Z`) - Date.parse(`${sunday}T12:00:00Z`)) / 86_400_000,
  );
  if (late > WEEKLY_CATCHUP_DAYS) return;
  const fail = weeklyFail(deps.store, sunday);
  if (fail && now.getTime() - fail.at < DIGEST_RETRY_MS) return;
  // La semana que acabó el domingo, no hasta hoy: lo del lunes ya entra en el repaso del
  // domingo que viene (antes, el repaso atrasado del lunes lo contaba y salía dos veces).
  const end = now.getTime() - late * 86_400_000;
  const weekly = composeWeekly(
    deps.store.processedBetween(
      chatId,
      new Date(end - 7 * 86_400_000).toISOString(),
      new Date(end).toISOString(),
    ),
  );
  const ok = weekly
    ? await deps.send(chatId, weekly, []).catch((err: unknown) => {
        deps.warn?.('bandeja: repaso de la semana no enviado', { err: String(err) });
        return false;
      })
    : true;
  const n = (fail?.n ?? 0) + 1;
  if (ok || n >= DIGEST_MAX_TRIES) {
    deps.store.setMeta('last_weekly_day', sunday);
    deps.store.setMeta('weekly_fail', null);
  } else deps.store.setMeta('weekly_fail', JSON.stringify({ sunday, n, at: now.getTime() }));
}

/** Manda el resumen si ya es la hora y hoy no ha salido. */
export async function runDigestIfDue(deps: DigestDeps): Promise<DigestStatus> {
  const now = deps.now();
  const day = localDay(now);
  const clock = wallClock(now);
  const pastHora = clock.hour * 60 + clock.minute >= minutesOfDay(digestHora(deps.store, deps.env));
  if (deps.store.getMeta('last_digest_day') === day) {
    // El resumen de hoy ya salió; el de la semana quizá no (falló y toca reintentar).
    if (pastHora && !inFlight) {
      const chatId = deps.owner();
      if (chatId) {
        inFlight = true;
        try {
          await sendWeeklyIfDue(deps, chatId, day, clock.weekday, now);
        } finally {
          inFlight = false;
        }
      }
    }
    return 'not-due';
  }
  if (!pastHora) return 'not-due';
  // Tras un fallo, no cada minuto: un resumen largo sale en 2–3 mensajes y, si el último
  // falla, repetir cada minuto mandaba los primeros otra vez (decenas de copias a la noche).
  const fail = digestFail(deps.store, day);
  if (fail && now.getTime() - fail.at < DIGEST_RETRY_MS) return 'not-due';
  if (inFlight) return 'busy';
  inFlight = true;
  try {
    const chatId = deps.owner();
    if (!chatId) return 'no-owner';
    const status = await sendDigest(deps, chatId, day, now);
    if (status === 'send-failed') {
      const n = (fail?.n ?? 0) + 1;
      if (n >= DIGEST_MAX_TRIES) {
        // Se deja para mañana: lo que no salió sigue sin resumir y entra en el siguiente.
        deps.store.setMeta('last_digest_day', day);
        deps.store.setMeta('digest_fail', null);
        deps.warn?.('bandeja: resumen sin enviar tras varios intentos; va en el de mañana', {
          tries: n,
        });
      } else deps.store.setMeta('digest_fail', JSON.stringify({ day, n, at: now.getTime() }));
    } else deps.store.setMeta('digest_fail', null);
    // Detrás, lo mejor de la semana (el domingo, o el primer día después si no salió).
    if (status !== 'send-failed') await sendWeeklyIfDue(deps, chatId, day, clock.weekday, now);
    return status;
  } finally {
    inFlight = false;
  }
}

/** El resumen de ahora mismo (también lo usa «/bandeja resumen»). */
export async function sendDigest(
  deps: DigestDeps,
  chatId: string,
  day: string,
  now: Date,
): Promise<DigestStatus> {
  const items = digestItems(deps.store, chatId, day);
  if (items.length === 0) {
    deps.store.setMeta('last_digest_day', day);
    return 'empty';
  }
  const digest = composeDigest(items, day, now);
  const ok = await deps.send(chatId, digest.text, digest.buttons).catch((err: unknown) => {
    deps.warn?.('bandeja: resumen no enviado', { err: String(err) });
    return false;
  });
  if (!ok) return 'send-failed';
  deps.store.setMeta('last_digest_day', day);
  afterDigest(deps.store, items, day, now, digest.ids);
  // «Si dices léelo entero, dame el PDF» (Nico, 10:58): el original del autor, si lo hay.
  if (deps.sendPdf) {
    for (const it of pdfsToAttach(items)) {
      await deps
        .sendPdf(chatId, it.extra.pdfUrl as string, pdfName(it))
        .catch((err: unknown) => deps.warn?.('bandeja: PDF no adjuntado', { err: String(err) }));
    }
  }
  if (deps.speak) {
    void deps
      .speak(chatId, spokenDigest(items))
      .catch((err: unknown) => deps.warn?.('bandeja: sin voz', { err: String(err) }));
  }
  return 'sent';
}

/** Lo 🔴 con PDF original (como mucho 3 por resumen). */
export function pdfsToAttach(items: readonly BandejaItem[]): BandejaItem[] {
  return items
    .filter((i) => i.status === 'listo' && i.verdict === 'imprescindible' && i.extra.pdfUrl)
    .slice(0, 3);
}

/** «Titulo-del-articulo.pdf» para el adjunto. */
export function pdfName(item: BandejaItem): string {
  const base = shortTitle(item, 60)
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${base || `bandeja-${item.id}`}.pdf`;
}

/** Versión para oír (corta): cuántas, y lo imprescindible por su nombre. */
export function spokenDigest(items: readonly BandejaItem[]): string {
  const red = items.filter((i) => i.verdict === 'imprescindible');
  const yellow = items.filter((i) => i.verdict === 'ideas');
  const chaff = items.filter((i) => i.verdict === 'paja');
  const parts = [`Hoy guardaste ${items.length === 1 ? 'una cosa' : `${items.length} cosas`}.`];
  if (red.length) {
    parts.push(`${red.length === 1 ? 'Una merece' : `${red.length} merecen`} tu tiempo entero:`);
    for (const it of red.slice(0, 4)) parts.push(`${shortTitle(it, 80)}. ${it.reason ?? ''}`);
  } else parts.push('Nada es imprescindible.');
  if (yellow.length)
    parts.push(
      yellow.length === 1
        ? 'Una tiene ideas buenas y con el resumen basta.'
        : `${yellow.length} tienen ideas buenas y con el resumen basta.`,
    );
  if (chaff.length)
    parts.push(chaff.length === 1 ? 'Y una es paja.' : `Y ${chaff.length} son paja.`);
  return parts.join(' ');
}

export const DIGEST_CHECK_EVERY_MS = 60_000;

export function startDigestTimer(deps: DigestDeps, everyMs = DIGEST_CHECK_EVERY_MS): () => void {
  const timer = setInterval(() => {
    runDigestIfDue(deps).catch((err: unknown) =>
      deps.warn?.('bandeja: comprobación falló', { err: String(err) }),
    );
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function _resetDigestForTests(): void {
  inFlight = false;
}
