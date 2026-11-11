/**
 * /bandeja desde Telegram (también /guardar):
 *   /bandeja                 lo de hoy, una línea por cosa (🔴🟡⚪⏳⚠️)
 *   /bandeja <enlace|texto>  guarda a mano; /bandeja libro <título> guarda un libro
 *   /bandeja ver N           la ficha de una (veredicto, nota, ideas, Goodreads) con botones
 *   /bandeja ahora N         la procesa ya (o la repite si falló) y manda su ficha
 *   /bandeja visto|manana|descartar N   lo mismo que los botones ✅ ⏭️ 🗑️
 *   /bandeja resumen         el resumen de hoy ahora (no cambia el de la noche)
 *   /bandeja semana          lo mejor de los últimos 7 días
 *   /bandeja pendientes      todo lo que queda por ver, de cualquier día
 *   /bandeja hora 22:00      la hora del resumen de cada noche
 *   /bandeja captura on|off  guardar solo lo que llega a secas (on) o solo con /bandeja (off)
 *   /bandeja compra N        «🛒 A la compra»: los ingredientes de esa receta a /compra
 *   /bandeja calendario N    «📅 Al calendario»: el evento de esa página a tu Google Calendar
 *   /bandeja releer N        vuelve a abrir la página y lee su receta o su evento (lo guardado antes)
 *   /bandeja releer todo [N días]   lo mismo con todo lo de los últimos 30 días, de una en una
 *   /bandeja kindle N [pdf]  «📖 Al Kindle»: el texto entero en EPUB (+AZW3 con Calibre, +PDF)
 *   /bandeja kindle <enlace> lo mismo con un enlace (también «/kindle <enlace>»)
 *   /bandeja kindle auto on|off      lo 🔴 para leer entero va solo al Kindle
 *   /bandeja kindle correo <x@kindle.com>|off   el correo a tu Kindle (apagado por defecto)
 */

import { isKindleAddress } from '../books/kindle.js';
import { commandButton } from '../channels/telegram-shared.js';
import { localDay } from '../datecontext.js';
import type { EventoArgs } from '../google/workspace.js';
import { ICS_SOURCE } from '../ics.js';
import { type CaptureCandidate, explicitCapture } from './captura.js';
import { cuandoTexto, eventoArgs, localWallTime, yaPaso } from './evento.js';
import {
  ackButtons,
  ackText,
  type Button,
  byVerdict,
  cardButtons,
  cardText,
  eventLine,
  kindEmoji,
  listText,
  shortTitle,
} from './formato.js';
import { type KindleTarget, kindleStatusText } from './kindle.js';
import type { BandejaQueue } from './procesar.js';
import {
  RELEER_TODO_DIAS,
  RELEER_TODO_MAX,
  RELEER_TODO_MAX_DIAS,
  releerCosa,
  releerTodo,
} from './releer.js';
import {
  composeDigest,
  composeWeekly,
  digestHora,
  digestItems,
  parseHora,
  pdfName,
  pdfsToAttach,
  tomorrowFor,
} from './resumen.js';
import type { BandejaItem, BandejaStore } from './store.js';

/**
 * ¿Puede tardar minutos esta orden? «/bandeja ahora N» (procesar ya: transcribir un
 * podcast) y «/bandeja kindle N|<enlace>» (bajar, armar el EPUB, Calibre, correo). El
 * daemon las corre aparte: Telegram atiende las actualizaciones de una en una y, mientras
 * una orden espera, no llega nada más (ni otro mensaje, ni /stop, ni el botón de una
 * aprobación). Ajustes como «kindle auto on» o «kindle correo …» son al momento.
 */
export function bandejaSlowSub(args: string): boolean {
  const [subRaw = '', next = ''] = args.trim().split(/\s+/);
  const sub = subRaw.toLowerCase();
  if (sub === 'ahora' || sub === 'ya') return true;
  // «🛒 A la compra» abre la página de la receta (hasta 30 s).
  if (sub === 'compra' || sub === 'apuntar') return true;
  // «🔄 Releer» abre la página otra vez (hasta 30 s).
  if (sub === 'releer' || sub === 'reprocesar') return true;
  if (sub !== 'kindle') return false;
  const opt = next.toLowerCase();
  return opt !== '' && !['auto', 'correo', 'email', 'mail'].includes(opt);
}

export interface BandejaReply {
  text: string;
  buttons?: Button[];
  /** Botones por fila (3 para ✅ ⏭️ 🗑️ de una misma cosa). */
  perRow?: number;
  /** PDF original que adjuntar detrás (lo 🔴 con PDF del autor). */
  pdf?: { url: string; name: string };
  /** La cosa de la que es este mensaje (contestarle «kindle» la manda al Kindle). */
  itemId?: number;
}

export interface BandejaCommandDeps {
  store: BandejaStore;
  queue: BandejaQueue;
  chatId: string;
  now: () => Date;
  /** Un aviso intermedio («⏳ Lo miro ahora…») antes de una respuesta lenta. */
  progress?: (text: string) => Promise<unknown>;
  /** Un fichero que vino con la orden (foto o PDF con pie «/bandeja»). */
  attached?: CaptureCandidate | null;
  /** «📖 Al Kindle»: arma y manda los ficheros; devuelve qué pasó (kindle.ts deliverToKindle). */
  kindle?: (target: KindleTarget) => Promise<string>;
  /**
   * «🛒 A la compra»: los ingredientes de la receta de esa cosa a la lista de /compra
   * (compra.ts recetaACompra con su enlace). Devuelve la lista con sus botones.
   */
  compra?: (item: BandejaItem) => Promise<{ text: string; buttons?: Button[] }>;
  /**
   * «📅 Al calendario»: crea el evento en su Google Calendar (google/workspace.ts
   * crearEvento); devuelve su respuesta («📅 Apuntado…» o el paso que falta).
   */
  calendario?: (args: EventoArgs) => Promise<string>;
  /** Su zona horaria (PA_TIMEZONE); por defecto, Europe/Madrid. */
  timeZone?: () => string;
  /** «🔄 Releer»: el HTML de una página (la misma descarga que usa la bandeja). */
  fetchPagina?: (url: string) => Promise<string>;
  /** La pausa entre páginas de «/bandeja releer todo» (en pruebas, sin esperar). */
  sleep?: (ms: number) => Promise<void>;
  env?: NodeJS.ProcessEnv;
}

/** ¿Está encendida la captura automática? /bandeja captura manda; si no, PA_BANDEJA_CAPTURA (por defecto sí). */
export function captureOn(store: BandejaStore, env: NodeJS.ProcessEnv = process.env): boolean {
  const set = store.getMeta('captura');
  if (set === 'on') return true;
  if (set === 'off') return false;
  const v = (env.PA_BANDEJA_CAPTURA ?? '').trim().toLowerCase();
  return !['0', 'off', 'no', 'false'].includes(v);
}

/** Guarda y encola; devuelve el aviso con sus botones. */
export function captureAndAck(
  deps: Pick<BandejaCommandDeps, 'store' | 'queue' | 'chatId' | 'now' | 'env'>,
  cands: readonly CaptureCandidate[],
): BandejaReply {
  const now = deps.now();
  const day = localDay(now);
  const saved = cands.map((c) => deps.store.add(deps.chatId, c, now, day));
  // Lo que ya estaba pero falló (⚠️): mandarlo otra vez es pedir otro intento. Antes
  // contestaba «Eso ya estaba» y no lo reintentaba nunca.
  for (const s of saved)
    if (!s.dup || s.item.status === 'error') void deps.queue.enqueue(s.item.id);
  return {
    text: ackText(
      saved,
      deps.store.countDay(deps.chatId, day),
      digestHora(deps.store, deps.env),
      // Guardado tras el resumen de esta noche: sale en el de mañana (antes decía «a las 21:30»).
      deps.store.getMeta('last_digest_day') === day,
    ),
    buttons: ackButtons(saved),
    ...(saved.length === 1 && saved[0] ? { itemId: saved[0].item.id } : {}),
  };
}

/** «/bandeja releer todo [N días]»: las páginas de esos días, de una en una (releer.ts). */
async function releerTodoSub(
  restParts: readonly string[],
  deps: BandejaCommandDeps,
): Promise<BandejaReply> {
  if (!deps.fetchPagina) return { text: 'Releer páginas no está disponible desde aquí.' };
  const n = Number(restParts[1]);
  const dias =
    Number.isSafeInteger(n) && n > 0 ? Math.min(RELEER_TODO_MAX_DIAS, n) : RELEER_TODO_DIAS;
  const r = await releerTodo(deps.store, deps.chatId, deps.fetchPagina, {
    now: deps.now(),
    dias,
    ...(deps.progress ? { progress: deps.progress } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });
  if (r === 'ocupado')
    return { text: '🔄 Ya estoy releyendo tu bandeja. Te digo qué traen en cuanto acabe.' };
  if (!r.total)
    return {
      text: `🔄 Nada que releer de los últimos ${dias} días: lo que tenía página ya está releído (o ya trae 🛒/📅).`,
    };
  const lines: string[] = [];
  const hechas = r.nuevas.length + r.igual;
  lines.push(
    `🔄 Releídas ${hechas === 1 ? '1 página' : `${hechas} páginas`}: ${r.nuevas.length ? `${r.nuevas.length} con algo nuevo` : 'ninguna trae receta ni evento nuevos'}.`,
  );
  const buttons: Button[] = [];
  for (const { item, nuevo } of r.nuevas) {
    lines.push(`#${item.id} ${shortTitle(item, 60)} — ${nuevo.join(' · ')}`);
    const cuando = eventLine(item, deps.now(), deps.timeZone?.());
    if (cuando && !cuando.endsWith('(ya pasó)')) {
      const b = commandButton(`📅 ${item.id} calendario`, 'bandeja', String(item.id), 'calendario');
      if (b) buttons.push(b);
    }
    if (item.extra.receta && item.extra.receta >= 2) {
      const b = commandButton(`🛒 ${item.id} compra`, 'bandeja', String(item.id), 'compra');
      if (b) buttons.push(b);
    }
  }
  if (r.fallidas)
    lines.push(
      `⚠️ ${r.fallidas === 1 ? '1 no abrió' : `${r.fallidas} no abrieron`}: lo intento otra vez en el siguiente «/bandeja releer todo».`,
    );
  if (r.quedan)
    lines.push(
      `Quedan ${r.quedan}: dime «/bandeja releer todo» otra vez y sigo (voy de ${RELEER_TODO_MAX} en ${RELEER_TODO_MAX} para no saturar las webs).`,
    );
  return { text: lines.join('\n'), ...(buttons.length ? { buttons, perRow: 2 } : {}) };
}

function ownItem(deps: BandejaCommandDeps, raw: string | undefined): BandejaItem | string {
  const id = Number((raw ?? '').replace(/^#/, ''));
  if (!Number.isSafeInteger(id) || id <= 0)
    return 'Dime el número, por ejemplo «/bandeja ver 12» (sale como #12 en /bandeja).';
  const item = deps.store.get(id);
  if (!item || item.chatId !== deps.chatId)
    return `No tengo la #${id} en tu bandeja. Mira /bandeja.`;
  return item;
}

const ON = ['on', 'si', 'sí', '1'];
const OFF = ['off', 'no', '0'];

/** «/bandeja kindle …» (y «/kindle …», que es lo mismo). */
async function kindleSub(parts: string[], deps: BandejaCommandDeps): Promise<BandejaReply> {
  const [first = '', second = ''] = parts;
  const opt = first.toLowerCase();
  if (!first) return { text: kindleStatusText(deps.store, deps.env) };
  if (opt === 'auto') {
    const v = second.toLowerCase();
    if (ON.includes(v)) {
      deps.store.setMeta('kindle_auto', 'on');
      return {
        text: '📖 Hecho: lo 🔴 «léelo entero» te llega solo en formato Kindle en cuanto lo juzgue (los vídeos no; para esos, «📖 Al Kindle» a mano).',
      };
    }
    if (OFF.includes(v)) {
      deps.store.setMeta('kindle_auto', 'off');
      return { text: '📖 Automático apagado: al Kindle solo lo que pidas con «📖 Al Kindle».' };
    }
    return { text: kindleStatusText(deps.store, deps.env) };
  }
  if (opt === 'correo' || opt === 'email' || opt === 'mail') {
    if (OFF.includes(second.toLowerCase())) {
      deps.store.setMeta('kindle_email', 'off');
      return { text: '📧 Correo al Kindle apagado: los ficheros te llegan solo por aquí.' };
    }
    if (!second || !isKindleAddress(second))
      return {
        text: 'Pásame tu dirección de Kindle, la que acaba en @kindle.com (Amazon → Contenido y dispositivos → Dispositivos → tu Kindle): «/bandeja kindle correo tu_nombre@kindle.com».',
      };
    deps.store.setMeta('kindle_email', second.trim());
    return {
      text: `📧 Hecho: lo que mandes al Kindle irá también a ${second.trim()}. Para que Amazon lo acepte, el correo de Asistenta tiene que estar en tu lista de remitentes aprobados: Amazon → Contenido y dispositivos → Preferencias → Documentos personales.`,
    };
  }
  if (!deps.kindle) return { text: 'El Kindle no está disponible desde aquí.' };
  const pdf = parts.slice(1).some((p) => p.toLowerCase() === 'pdf');
  if (/^https?:\/\//i.test(first)) {
    await deps.progress?.('📖 Lo preparo para el Kindle…').catch(() => undefined);
    return { text: await deps.kindle({ url: first, pdf }) };
  }
  const item = ownItem(deps, first);
  if (typeof item === 'string') return { text: `${item.replace('/bandeja ver 12', '/kindle 12')}` };
  await deps
    .progress?.(`📖 Preparo #${item.id} ${shortTitle(item, 60)} para el Kindle…`)
    .catch(() => undefined);
  return { text: await deps.kindle({ item, pdf }), itemId: item.id };
}

/**
 * «📅 Al calendario» (calendario): enseña qué apuntaría y pide el «✅ Sí, apúntalo»
 * (apuntar), que lo crea UNA vez en su Google Calendar. Lo que ya pasó no se apunta.
 */
async function calendarioSub(
  sub: string,
  raw: string | undefined,
  deps: BandejaCommandDeps,
): Promise<BandejaReply> {
  const item = ownItem(deps, raw);
  if (typeof item === 'string') return { text: item };
  const ev = item.extra.evento;
  if (!ev) {
    // Guardado antes del 11-nov (o la página cambió): «🔄 Releer» la vuelve a mirar.
    const releer = item.url
      ? commandButton('🔄 Releer la página', 'bandeja', String(item.id), 'releer')
      : undefined;
    return {
      text: `#${item.id} no trae la fecha de un evento.${releer ? ' Si lo guardaste hace tiempo, toca «🔄 Releer la página» y la vuelvo a mirar.' : ''} O dime «apunta en el calendario …» con el día y la hora y lo hago.`,
      ...(releer ? { buttons: [releer] } : {}),
    };
  }
  const tz = deps.timeZone?.() ?? 'Europe/Madrid';
  const args = eventoArgs(ev, tz, item.url);
  const cuando = cuandoTexto(args);
  const mark = `cal_added_${item.id}`;
  // La marca guarda con qué fecha se apuntó («inicio=…»). Si «🔄 Releer la página» trae otra
  // fecha (el congreso se movió), antes decía «ya está en tu calendario» con la fecha NUEVA,
  // y en su calendario seguía la vieja (bugs-36). Una marca antigua (sin fecha) vale como
  // la de ahora.
  const marca = deps.store.getMeta(mark);
  const conFecha = marca?.startsWith('inicio=') ? marca.slice('inicio='.length) : null;
  const otraFecha = Boolean(marca && conFecha !== null && conFecha !== ev.inicio);
  if (marca && !otraFecha)
    return { text: `📅 #${item.id} ya está en tu calendario: «${ev.nombre}», ${cuando}.` };
  if (yaPaso(args, localWallTime(deps.now().toISOString(), tz)))
    return { text: `📅 «${ev.nombre}» ya pasó (${cuando}): no lo apunto.` };
  if (sub === 'calendario') {
    const yes = commandButton('✅ Sí, apúntalo', 'bandeja', String(item.id), 'apuntar');
    const { fin: _fin, ...sinFin } = ev;
    const antes = otraFecha
      ? `⚠️ Lo apuntaste con otra fecha (${cuandoTexto(eventoArgs({ ...sinFin, inicio: conFecha ?? ev.inicio }, tz, item.url))}) y la página dice ahora otra. Borra el de antes en tu calendario si ya no vale.\n`
      : '';
    return {
      text: `${antes}📅 ¿Lo apunto en tu Google Calendar?
«${ev.nombre}»
🗓️ ${cuando}${
        ev.lugar
          ? `
📍 ${ev.lugar}`
          : ''
      }`,
      ...(yes ? { buttons: [yes] } : {}),
      itemId: item.id,
    };
  }
  if (!deps.calendario) return { text: 'El calendario no está disponible desde aquí.' };
  // «apuntar» va aparte (bandejaSlowSub), así que un doble toque corría a la vez y los dos
  // veían «no apuntado»: dos eventos en su calendario (bugs-35). Uno a la vez por cosa.
  const busy = `${deps.chatId}:${item.id}`;
  if (calendarioEnCurso.has(busy))
    return { text: `📅 Ya lo estoy apuntando: «${ev.nombre}», ${cuando}.` };
  calendarioEnCurso.add(busy);
  try {
    const text = await deps.calendario(args);
    // Solo si de verdad se apuntó: sin Google conectado, el siguiente toque lo intenta otra vez.
    if (text.startsWith('📅 Apuntado')) deps.store.setMeta(mark, `inicio=${ev.inicio}`);
    return { text };
  } finally {
    calendarioEnCurso.delete(busy);
  }
}

/**
 * Al acabar de leer una invitación .ics (procesar.ts, sin modelo): la pregunta de «📅 Al
 * calendario» al momento, con su «✅ Sí, apúntalo» (no espera al resumen de la noche). Una
 * cancelación lo dice. null si no es un .ics.
 */
export async function icsAviso(
  item: BandejaItem,
  deps: BandejaCommandDeps,
): Promise<BandejaReply | null> {
  if (item.extra.source !== ICS_SOURCE || item.status !== 'listo') return null;
  if (!item.extra.evento)
    return {
      text: `❌ #${item.id} ${item.reason ?? 'Es la cancelación de un evento.'}`,
      itemId: item.id,
    };
  const r = await calendarioSub('calendario', String(item.id), deps);
  return { ...r, text: `📅 #${item.id} es una invitación. ${r.text}` };
}

/** Los «✅ Sí, apúntalo» que aún están creando su evento (chat:número). */
const calendarioEnCurso = new Set<string>();

const HELP = [
  '📥 La bandeja: mándame a secas (sin escribir nada más) enlaces de YouTube, X o artículos, PDFs, capturas o «libro: título», y los guardo.',
  'Cada noche te digo qué hacer con cada cosa: 🔴 imprescindible (entero) · 🟡 ideas buenas (basta el resumen) · ⚪ paja, con nota del 1 al 10.',
  'Si escribes algo con el enlace («resúmeme esto…»), te contesto como siempre.',
  '',
  '/bandeja — lo de hoy · /bandeja ver N — ficha · /bandeja resumen — el resumen ya',
  '/bandeja semana · /bandeja pendientes · /bandeja hora 22:00 · /bandeja captura off',
  '📖 /kindle N o /kindle <enlace> — el texto entero para el Kindle · /bandeja kindle — ajustes',
  '🔄 /bandeja releer N — vuelve a mirar la página (receta 🛒 o evento 📅 de algo guardado antes)',
  '🔄 /bandeja releer todo — lo mismo con lo de los últimos 30 días (de una en una)',
].join('\n');

export async function bandejaCommand(
  args: string,
  deps: BandejaCommandDeps,
): Promise<BandejaReply> {
  const trimmed = args.trim();
  const [subRaw, ...restParts] = trimmed.split(/\s+/);
  const sub = (subRaw ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const rest = restParts.join(' ').trim();
  const now = deps.now();
  const today = localDay(now);
  const hora = digestHora(deps.store, deps.env);

  if (!trimmed && deps.attached) return captureAndAck(deps, [deps.attached]);

  switch (sub) {
    case '':
    case 'hoy': {
      const items = deps.store.ofDay(deps.chatId, today);
      const carried = deps.store
        .pending(deps.chatId)
        .filter((i) => i.day !== today && i.verdict === 'imprescindible');
      return { text: listText(items, carried, hora) };
    }
    case 'ayuda':
    case 'help':
      return { text: HELP };
    case 'ver':
    case 'ficha': {
      const item = ownItem(deps, restParts[0]);
      if (typeof item === 'string') return { text: item };
      return {
        text: cardText(item, deps.now()),
        buttons: cardButtons(item),
        perRow: 3,
        itemId: item.id,
      };
    }
    case 'ahora':
    case 'ya': {
      const item = ownItem(deps, restParts[0]);
      if (typeof item === 'string') return { text: item };
      if (item.status !== 'listo') {
        if (item.status === 'error') deps.store.setStatus(item.id, 'nuevo');
        await deps
          .progress?.(`⏳ Mirando #${item.id} ${kindEmoji(item.kind)} ${shortTitle(item, 60)}…`)
          .catch(() => undefined);
        await deps.queue.enqueue(item.id, { first: true });
      }
      const fresh = deps.store.get(item.id) ?? item;
      const pdf = pdfsToAttach([fresh])[0];
      return {
        text: cardText(fresh, deps.now()),
        buttons: cardButtons(fresh),
        perRow: 3,
        itemId: fresh.id,
        ...(pdf?.extra.pdfUrl ? { pdf: { url: pdf.extra.pdfUrl, name: pdfName(pdf) } } : {}),
      };
    }
    case 'visto': {
      const item = ownItem(deps, restParts[0]);
      if (typeof item === 'string') return { text: item };
      deps.store.setState(item.id, 'visto');
      return { text: `✅ #${item.id} visto: ${shortTitle(item, 60)}.` };
    }
    case 'manana': {
      const item = ownItem(deps, restParts[0]);
      if (typeof item === 'string') return { text: item };
      if (item.state !== 'pendiente') deps.store.setState(item.id, 'pendiente');
      deps.store.moveTo(item.id, tomorrowFor(now));
      return { text: `⏭️ #${item.id} para mañana: ${shortTitle(item, 60)}.` };
    }
    case 'descartar':
    case 'quitar':
    case 'borrar': {
      const item = ownItem(deps, restParts[0]);
      if (typeof item === 'string') return { text: item };
      deps.store.setState(item.id, 'descartado');
      return { text: `🗑️ #${item.id} fuera: ${shortTitle(item, 60)}.` };
    }
    case 'paja': {
      const m = /^(\d{4})(\d{2})(\d{2})$/.exec(restParts[0] ?? '');
      const upTo = m ? `${m[1]}-${m[2]}-${m[3]}` : today;
      const chaff = deps.store
        .pending(deps.chatId)
        .filter((i) => i.verdict === 'paja' && i.day <= upTo);
      for (const it of chaff) deps.store.setState(it.id, 'descartado');
      return {
        text: chaff.length
          ? `🧹 Quitada la paja: ${chaff.length} cosa${chaff.length === 1 ? '' : 's'}.`
          : '🧹 No quedaba paja.',
      };
    }
    case 'resumen': {
      const items = digestItems(deps.store, deps.chatId, today);
      const d = composeDigest(items, today, now);
      return {
        text: d.empty ? `${d.text} Mándame enlaces o PDFs a secas y te los filtro.` : d.text,
        buttons: d.buttons,
        perRow: 3,
      };
    }
    case 'semana': {
      const items = deps.store.processedBetween(
        deps.chatId,
        new Date(now.getTime() - 7 * 86_400_000).toISOString(),
        now.toISOString(),
      );
      return { text: composeWeekly(items) ?? '🏆 Esta semana no guardaste nada en la bandeja.' };
    }
    case 'pendientes':
    case 'todo': {
      const items = deps.store.pending(deps.chatId).sort(byVerdict);
      if (!items.length) return { text: '📥 No te queda nada pendiente en la bandeja.' };
      const lines = [`📥 Pendiente de ver: ${items.length}`];
      for (const it of items.slice(0, 40)) {
        const mark =
          it.verdict === 'imprescindible'
            ? '🔴'
            : it.verdict === 'ideas'
              ? '🟡'
              : it.verdict === 'paja'
                ? '⚪'
                : it.status === 'error'
                  ? '⚠️'
                  : '⏳';
        lines.push(
          `${mark} #${it.id} ${kindEmoji(it.kind)} ${shortTitle(it, 60)}${it.score ? ` ${it.score}/10` : ''}`,
        );
      }
      if (items.length > 40) lines.push(`…y ${items.length - 40} más.`);
      return { text: lines.join('\n') };
    }
    case 'hora': {
      const h = parseHora(rest);
      if (!h)
        return {
          text: `El resumen de la bandeja sale a las ${hora}. Para cambiarlo: «/bandeja hora 22:00».`,
        };
      deps.store.setMeta('hora', h);
      // Si el de hoy ya salió, no se repite; si aún no, sale a la hora nueva.
      return { text: `⏰ Hecho: el resumen de la bandeja sale cada noche a las ${h}.` };
    }
    case 'captura': {
      const v = rest.toLowerCase();
      if (['on', 'si', 'sí', '1'].includes(v)) {
        deps.store.setMeta('captura', 'on');
        return {
          text: '📥 Captura encendida: lo que me mandes a secas (enlaces, PDFs, capturas) va a la bandeja.',
        };
      }
      if (['off', 'no', '0'].includes(v)) {
        deps.store.setMeta('captura', 'off');
        return {
          text: '📥 Captura apagada: solo guardo con «/bandeja <enlace>» o «libro: título». Lo demás te lo contesto como siempre.',
        };
      }
      return {
        text: `La captura automática está ${captureOn(deps.store, deps.env) ? 'encendida' : 'apagada'}. «/bandeja captura on|off».`,
      };
    }
    case 'kindle':
      return kindleSub(restParts, deps);
    case 'compra': {
      const item = ownItem(deps, restParts[0]);
      if (typeof item === 'string') return { text: item };
      if (!item.url)
        return {
          text: `#${item.id} no tiene enlace de receta. Pega sus ingredientes con /compra receta y los apunto.`,
        };
      if (!deps.compra) return { text: 'La lista de la compra no está disponible desde aquí.' };
      await deps
        .progress?.(`🛒 Apunto los ingredientes de #${item.id} ${shortTitle(item, 60)}…`)
        .catch(() => undefined);
      const view = await deps.compra(item);
      return { text: view.text, ...(view.buttons?.length ? { buttons: view.buttons } : {}) };
    }
    case 'releer':
    case 'reprocesar': {
      if (/^(todo|todos|todas|all)$/i.test(restParts[0] ?? ''))
        return releerTodoSub(restParts, deps);
      const item = ownItem(deps, restParts[0]);
      if (typeof item === 'string') return { text: item };
      if (!deps.fetchPagina) return { text: 'Releer páginas no está disponible desde aquí.' };
      const r = await releerCosa(deps.store, item, deps.fetchPagina, now);
      if (typeof r === 'string') return { text: r };
      const head = r.nuevo.length
        ? `🔄 Releída: ${r.nuevo.join(' · ')}.`
        : '🔄 Releída: no trae receta ni evento nuevos.';
      return {
        text: `${head}

${cardText(r.item, now)}`,
        buttons: cardButtons(r.item),
        perRow: 3,
        itemId: r.item.id,
      };
    }
    case 'calendario':
    case 'apuntar':
      return calendarioSub(sub, restParts[0], deps);
    default: {
      const cands = explicitCapture(trimmed);
      if (!cands) return { text: HELP };
      return captureAndAck(deps, cands);
    }
  }
}
