/**
 * El ojo de águila: avisar de lo nuevo sin que se le pida.
 *
 * Un asistente que solo responde obliga al usuario a acordarse de preguntar. Este
 * módulo hace el barrido contrario: cada cierto tiempo mira la agenda unificada
 * (calendario + correo + pendientes, vía `buildAgenda`) y avisa por Telegram de lo
 * que APARECE de nuevo — un deadline en un correo, un pago próximo, un viaje.
 *
 * Reglas que hacen que el aviso sea de fiar y no ruido:
 *
 * 1. **Cada hallazgo se notifica UNA vez.** La clave es estable (tipo + título
 *    normalizado + día LOCAL del usuario), guardada en sqlite. Un mismo evento
 *    redescubierto en cada barrido no vuelve a molestar.
 * 2. **Sin fecha no hay hallazgo, y lo vencido tampoco.** El extractor ya se niega
 *    a inventar fechas; el vigilante además descarta lo que no tiene `at` y los
 *    pendientes cuya fecha ya pasó: un aviso de algo vencido llega tarde para siempre.
 * 3. **El envío fallido se reintenta, no se olvida.** Solo se marca como notificado
 *    lo que Telegram confirmó; un fallo de red deja el hallazgo pendiente para el
 *    siguiente barrido.
 * 4. **El mensaje no promete más que la fuente.** Cada línea declara de dónde sale
 *    (calendario/correo/pendiente) y, si el extractor heurístico del correo dio
 *    confianza baja, lo dice: inferido nunca se presenta como confirmado.
 * 5. **El destinatario es el DM del owner, o nadie.** Un chat de grupo con un
 *    usuario permitido es una audiencia distinta: la agenda privada no va ahí.
 *    Y el owner no se deduce de los hilos que existen: la allowlist autoriza
 *    USO del bot, no propiedad de la agenda. Owner = el único usuario de la
 *    allowlist (asistente personal) o `vigilante:ownerUserId` en vault, fijado
 *    explícitamente. Sin owner verificado, el hallazgo espera.
 *
 * `runVigilanteOnce` no lanza: todo el cuerpo va dentro de un try, porque el
 * vigilante no puede ser lo que tumbe el daemon. El barrido es barato y sin LLM:
 * la inteligencia (qué es un deadline, qué es ruido) vive en `src/agenda/extract.ts`.
 */

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { zonedDayKey, zonedDayStart } from './agenda/ics.js';
import type { AgendaItem, AgendaKind, UnifiedAgenda } from './agenda/unified.js';
import { localTimeZone } from './datecontext.js';
import { log } from './log.js';
import type { MailMessage } from './mail/types.js';
import {
  type Conflict,
  dueStages,
  findConflicts,
  formatConflicts,
  inQuietHours,
  isCritical,
  MAX_CONFLICTS,
  occurrenceKey,
  type QuietHours,
  type ReminderStage,
  stageKey,
  whenRelative,
} from './ojo.js';
import {
  chargeBaseline,
  formatChargeAlerts,
  ingestCharges,
  markChargesNotified,
  pendingChargeAlerts,
} from './ojo-charges.js';
import {
  formatDownloads,
  getDownloadsEnabled,
  lostSinceReport,
  markDownloadsNotified,
  markLostReported,
  pendingDownloads,
} from './ojo-downloads.js';
import {
  confirmNotices,
  dropStaleReservations,
  initIgnoreStore,
  loadIgnoreState,
  releaseNotices,
  reserveNotices,
  ruleSuppresses,
} from './ojo-ignore.js';
import { formatScreen, getScreenEnabled, markScreenNotified, pendingScreen } from './ojo-screen.js';
import { loadTracked, trackItems } from './ojo-track.js';

/** Tipos que merecen aviso proactivo. `reminder`/`other` no: o ya avisa otro, o es ruido. */
export const VIGILANTE_KINDS: readonly AgendaKind[] = ['deadline', 'payment', 'travel', 'meeting'];

/** Tope de hallazgos por aviso: un digest de 30 líneas no se lee, se silencia. */
export const MAX_HALLAZGOS = 5;

/** Tope de título, como en la agenda: un asunto de correo no acotado infla el digest. */
export const MAX_TITULO = 90;

/** Tope por defecto para construir la agenda: una fuente colgada no puede eternizar un barrido. */
export const AGENDA_TIMEOUT_MS = 60_000;

/** Rechaza `p` si tarda más de `ms`: el temporizador gana aunque la promesa no se rinda nunca. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label}: más de ${ms} ms sin respuesta`));
    }, ms);
    timer.unref?.();
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

const DAY_MS = 86_400_000;

export interface VigilanteDeps {
  /** La agenda unificada ya construida (fuentes inyectadas fuera, testeable). */
  agenda: () => Promise<UnifiedAgenda>;
  /** Entrega el texto; devuelve si llegó. */
  send: (text: string) => Promise<boolean>;
  db: DatabaseSync;
  now?: () => number;
  maxItems?: number;
  /**
   * Cierre ordenado: se consulta antes de ENVIAR (durante el apagado no salen
   * avisos nuevos). Una entrega ya confirmada se persiste siempre — el drain de
   * `stop()` la espera antes de que se cierren las bases de datos.
   */
  shouldAbort?: () => boolean;
  /**
   * Tope para construir la agenda (ICS/IMAP colgados). Sin él, el drain de
   * `stop()` podría esperar una fuente colgada y el daemon no cerraría nunca.
   */
  agendaTimeoutMs?: number;
  /**
   * Horas de silencio (hora local). Sin esto no hay silencio: lo activa el
   * cableado del daemon, así los tests y otros usos son deterministas.
   */
  quiet?: QuietHours;
  /**
   * Correos para vigilar cargos raros desde ese instante (epoch ms). Opcional: sin él no
   * hay detección de cargos. La primera ejecución pide `CHARGE_SEED_DAYS` días para
   * sembrar el historial sin avisar de nada; las siguientes, solo los últimos días.
   */
  charges?: (sinceMs: number) => Promise<MailMessage[]>;
  /**
   * Descargas: comprueba/reintenta el vigilante de carpeta (si está encendido) al empezar
   * cada barrido, y devuelve cuántos eventos suprimió por ritmo desde que arrancó.
   */
  downloadsHealth?: () => Promise<unknown>;
  downloadsSuppressed?: () => number;
  /**
   * Pantalla (solo si /ojo pantalla on): una lectura de la pantalla por barrido, fuera de las
   * horas de silencio. Con tope de tiempo: una captura u OCR colgados no bloquean el barrido.
   */
  screenScan?: () => Promise<unknown>;
}

export const CHARGE_SEED_DAYS = 120;
const CHARGE_RECENT_DAYS = 3;

export interface VigilanteResult {
  /** Hallazgos candidatos vistos en este barrido. */
  seen: number;
  /** Hallazgos nuevos de verdad (tras dedupe intra-barrido y contra sqlite). */
  fresh: number;
  /** Hallazgos cuya notificación se confirmó en este barrido. */
  notified: number;
}

export function initVigilanteStore(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vigilante_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  // Etapas de recordatorio y conflictos: tabla aparte, para que vigilante_seen siga
  // siendo exactamente "lo descubierto y avisado".
  db.exec(`
    CREATE TABLE IF NOT EXISTS vigilante_stages (
      key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      at INTEGER,
      notified_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS vigilante_seen (
      key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      at INTEGER,
      notified_at INTEGER NOT NULL
    )
  `);
}

/** Interruptor general del ojo: encendido por defecto, `/ojo off` lo apaga. */
export function getOjoEnabled(db: DatabaseSync): boolean {
  initVigilanteStore(db);
  const row = db.prepare("SELECT value FROM vigilante_settings WHERE key = 'enabled'").get() as
    | { value: string }
    | undefined;
  return row?.value !== 'off';
}

export function setOjoEnabled(db: DatabaseSync, enabled: boolean): void {
  initVigilanteStore(db);
  db.prepare(
    "INSERT INTO vigilante_settings (key, value) VALUES ('enabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(enabled ? 'on' : 'off');
}

/**
 * Clave estable de un hallazgo: tipo + título normalizado + DÍA LOCAL (no el instante,
 * no el día UTC). El mismo evento redescubierto a otra hora del mismo día del usuario
 * es el mismo hallazgo; en UTC, la medianoche local de Madrid parte el día en dos.
 */
export function findingKey(item: AgendaItem, timeZone: string = localTimeZone()): string {
  const title = item.title.trim().toLowerCase().replace(/\s+/g, ' ');
  const day = item.at == null ? 'sin-fecha' : zonedDayKey(item.at, timeZone);
  return createHash('sha256').update(`${item.kind}|${day}|${title}`).digest('hex').slice(0, 24);
}

/**
 * Candidatos de la agenda: con fecha conocida y vigente (hoy o futuro, dentro de la
 * misma ventana que la agenda), de un tipo que merece aviso, ordenados por cuándo
 * tocan. Incluye los pendientes con fecha — un plazo apuntado en el tracker es tan
 * hallazgo como uno leído en el correo. SIN cap aquí: capar antes de descartar lo ya
 * notificado dejaría los hallazgos 6+ esperando a que venzan los primeros.
 */
/** Ventana de aviso de lo que no es una caducidad (días después de hoy). */
const BASE_DAYS = 7;

export function collectFindings(
  agenda: UnifiedAgenda,
  timeZone: string,
  now: number = Date.now(),
): AgendaItem[] {
  const dayStart = zonedDayStart(now, timeZone);
  const tomorrow = zonedDayStart(dayStart + DAY_MS, timeZone);
  // La misma ventana que unified.ts: `days` días DESPUÉS de hoy.
  const horizon = zonedDayStart(tomorrow + agenda.days * DAY_MS, timeZone);
  const pendingVigente = agenda.pending.filter(
    (item) => item.at != null && item.at >= dayStart && item.at < horizon,
  );
  // Lo normal avisa a 7 días vista; solo las caducidades miran más lejos (30 días).
  const baseHorizon = zonedDayStart(tomorrow + BASE_DAYS * DAY_MS, timeZone);
  return [...agenda.today, ...agenda.upcoming, ...pendingVigente]
    .filter((item) => item.at != null && VIGILANTE_KINDS.includes(item.kind))
    .filter((item) => agenda.days <= BASE_DAYS || item.expiry || (item.at as number) < baseHorizon)
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}

/**
 * Quién es el owner, o null si no se puede saber. La allowlist autoriza USO del
 * bot, no propiedad de la agenda: con varios usuarios permitidos, "el único que
 * ha hablado" podría ser cualquiera. Solo dos pruebas valen:
 *
 * - la allowlist tiene UN usuario (asistente personal: ese es el dueño), o
 * - `vigilante:ownerUserId` (config explícita) lo fija — y debe estar allowlisted,
 *   porque un owner que no puede usar el bot es una config rota, no un owner.
 */
export function resolveOwnerUserId(
  allowedUserIds: readonly number[],
  configuredOwnerId: number | null,
): number | null {
  if (configuredOwnerId != null) {
    return allowedUserIds.includes(configuredOwnerId) ? configuredOwnerId : null;
  }
  return allowedUserIds.length === 1 ? (allowedUserIds[0] ?? null) : null;
}

/**
 * El DM del owner entre los hilos conocidos, o null. El chatId de un DM de Telegram
 * es el id del usuario, así que la coincidencia exacta con el owner verificado es la
 * prueba; grupos y canales (ids negativos) y otros canales ni se miran.
 */
/** Solo el DM del owner verificado puede usar /ignora y /ignorados: la agenda es privada. */
export function isOwnerDm(
  m: { channel: string; chatId: string; userId: string },
  ownerUserId: number | null,
): boolean {
  if (ownerUserId == null || m.channel !== 'telegram') return false;
  const wanted = String(ownerUserId);
  return m.chatId === wanted && m.userId === wanted;
}

export function resolveOwnerDmChatId(
  chatKeys: Iterable<string>,
  ownerUserId: number | null,
): string | null {
  if (ownerUserId == null) return null;
  const wanted = String(ownerUserId);
  for (const key of chatKeys) {
    const [channel, , chatId] = key.split(':');
    if (channel === 'telegram' && chatId === wanted) return chatId;
  }
  return null;
}

const KIND_LABEL: Record<string, string> = {
  deadline: 'Plazo',
  payment: 'Pago',
  travel: 'Viaje',
  meeting: 'Cita',
};

const WHERE_TAG: Record<string, string> = {
  calendario: 'calendario',
  correo: 'correo',
  pendiente: 'pendiente',
};

/** Cuándo toca, sin inventar hora: "todo el día" y "sin hora" se dicen, no se disimulan. */
function formatWhen(item: AgendaItem, timeZone: string): string {
  if (item.at == null) return 'sin fecha';
  const day = new Intl.DateTimeFormat('es-ES', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone,
  }).format(new Date(item.at));
  if (item.allDay) return `${day} (todo el día)`;
  if (item.timed === false) return `${day} (sin hora)`;
  const time = new Intl.DateTimeFormat('es-ES', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(new Date(item.at));
  return `${day}, ${time}`;
}

/**
 * Digest en español, una línea por hallazgo. Cada línea declara su fuente y, si la
 * confianza del extractor es baja (<0.8, el mismo umbral que la agenda), lo dice:
 * un plazo leído por heurística en un correo es una sospecha razonable, no un hecho.
 */
export function formatFindings(
  items: AgendaItem[],
  timeZone: string,
  numbers?: readonly number[],
): string {
  const lines = items.map((item, i) => {
    const label = item.expiry ? 'Caducidad' : (KIND_LABEL[item.kind] ?? item.kind);
    const title = item.title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITULO) || '(sin título)';
    const tag =
      item.sources && item.sources.length > 1
        ? item.sources.map((where) => WHERE_TAG[where] ?? where).join('+')
        : (WHERE_TAG[item.where] ?? item.where);
    const doubt =
      item.confidence !== undefined && item.confidence < 0.8
        ? ` (${Math.round(item.confidence * 100)}% seguro)`
        : '';
    return `• ${label}: ${title} — ${formatWhen(item, timeZone)} (${tag})${doubt}${numbers?.[i] ? ` [#${numbers[i]}]` : ''}`;
  });
  const header =
    items.length === 1
      ? '🦅 Ojo de águila: 1 cosa nueva'
      : `🦅 Ojo de águila: ${items.length} cosas nuevas`;
  return `${header}\n${lines.join('\n')}`;
}

interface Reminder {
  item: AgendaItem;
  stage: ReminderStage;
  /** Etapas ya alcanzadas de este hallazgo: salen todas marcadas, solo la última se dice. */
  covered: ReminderStage[];
}

export function formatReminders(
  reminders: Reminder[],
  now: number,
  timeZone: string,
  numbers?: readonly number[],
): string {
  const lines = reminders.map(({ item }, i) => {
    const label = item.expiry ? 'Caducidad' : (KIND_LABEL[item.kind] ?? item.kind);
    const title = item.title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITULO) || '(sin título)';
    const tag =
      item.sources && item.sources.length > 1
        ? item.sources.map((where) => WHERE_TAG[where] ?? where).join('+')
        : (WHERE_TAG[item.where] ?? item.where);
    const doubt =
      item.confidence !== undefined && item.confidence < 0.8
        ? ` (${Math.round(item.confidence * 100)}% seguro)`
        : '';
    return `• ${label}: ${title} — ${whenRelative(item, now, timeZone)}; ${formatWhen(item, timeZone)} (${tag})${doubt}${numbers?.[i] ? ` [#${numbers[i]}]` : ''}`;
  });
  return `⏰ Recordatorio: ${reminders.length === 1 ? '1 cosa próxima' : `${reminders.length} cosas próximas`}\n${lines.join('\n')}`;
}

/**
 * Un barrido: construye la agenda, difiere contra lo ya notificado y avisa solo de
 * lo nuevo. El cap se aplica DESPUÉS de descartar lo ya visto: capar antes dejaría
 * los hallazgos 6+ sin avisar hasta que venzan los primeros. No lanza nunca: una
 * fuente rota, una base de datos cerrada o un envío fallido dejan nota en el log y
 * el siguiente barrido lo intenta de nuevo.
 */
/** Marca de entrega servida dentro de la ventana crítica (<2 h) de una ocurrencia. */
const critKey = (occ: string): string => `${occ}:crit`;

const sweepChains = new WeakMap<object, Promise<unknown>>();

/** Barridos serializados por base de datos: dos solapados no se pisan números ni etapas. */
export function runVigilanteOnce(deps: VigilanteDeps, timeZone: string): Promise<VigilanteResult> {
  const prev = sweepChains.get(deps.db) ?? Promise.resolve();
  const next = prev.then(
    () => sweepOnce(deps, timeZone),
    () => sweepOnce(deps, timeZone),
  );
  sweepChains.set(deps.db, next);
  return next;
}

async function sweepOnce(deps: VigilanteDeps, timeZone: string): Promise<VigilanteResult> {
  const zero: VigilanteResult = { seen: 0, fresh: 0, notified: 0 };
  try {
    initVigilanteStore(deps.db);
    dropStaleReservations(deps.db);
    // Interruptor general (/ojo off): apagado no mira ni avisa de nada.
    if (!getOjoEnabled(deps.db)) return zero;
    const now = deps.now ?? Date.now;
    const agenda = await withTimeout(
      deps.agenda(),
      Math.max(1, deps.agendaTimeoutMs ?? AGENDA_TIMEOUT_MS),
      'vigilante: construir la agenda',
    );
    if (deps.downloadsHealth && getDownloadsEnabled(deps.db)) {
      await withTimeout(
        deps.downloadsHealth(),
        Math.max(1, deps.agendaTimeoutMs ?? AGENDA_TIMEOUT_MS),
        'vigilante: salud de descargas',
      ).catch((err: unknown) => {
        log.warn('vigilante: descargas no disponibles en este barrido', { err: String(err) });
      });
    }
    // Cargos raros: se incorporan al historial (la primera vez solo se siembra).
    if (deps.charges) {
      try {
        const since =
          chargeBaseline(deps.db) === null
            ? now() - CHARGE_SEED_DAYS * DAY_MS
            : now() - CHARGE_RECENT_DAYS * DAY_MS;
        const msgs = await withTimeout(
          deps.charges(since),
          Math.max(1, deps.agendaTimeoutMs ?? AGENDA_TIMEOUT_MS),
          'vigilante: correos de cargos',
        );
        ingestCharges(deps.db, msgs, now());
      } catch (err) {
        log.warn('vigilante: cargos no disponibles en este barrido', { err: String(err) });
      }
    }
    // /ojo off durante la espera de la agenda: este barrido ya no avisa ni marca.
    if (!getOjoEnabled(deps.db)) return zero;

    const nowMs = now();
    const findings = collectFindings(agenda, timeZone, nowMs);

    // Dedupe intra-barrido: dos fuentes pueden traer el mismo hallazgo dos veces y
    // el digest diría la misma cosa en dos bullets.
    const unique = new Map<string, AgendaItem>();
    for (const item of findings) {
      const key = findingKey(item, timeZone);
      if (!unique.has(key)) unique.set(key, item);
    }

    // Ocurrencias exactas (para etapas y solapes), agrupadas por su clave de descubrimiento.
    const occurrences = new Map<string, AgendaItem>();
    for (const item of findings) {
      const ok = occurrenceKey(item);
      if (!occurrences.has(ok)) occurrences.set(ok, item);
    }
    // Lo ya avisado por correo y seguido en la base: SOLO para sus recordatorios (no
    // dependen de que el correo siga en la ventana de lectura). Nunca entra en
    // descubrimiento ni en conflictos: una cosa que ya no está en la agenda no choca con nada.
    const reminderSources = new Map(occurrences);
    for (const item of loadTracked(deps.db, nowMs)) {
      const ok = occurrenceKey(item);
      if (!reminderSources.has(ok)) reminderSources.set(ok, item);
    }
    const occByFinding = new Map<string, Array<[string, AgendaItem]>>();
    for (const [ok, item] of occurrences) {
      const fk = findingKey(item, timeZone);
      const list = occByFinding.get(fk) ?? [];
      list.push([ok, item]);
      occByFinding.set(fk, list);
    }

    const known = new Set(
      (deps.db.prepare('SELECT key FROM vigilante_seen').all() as Array<{ key: string }>).map(
        (r) => r.key,
      ),
    );
    const marked = new Set(
      (deps.db.prepare('SELECT key FROM vigilante_stages').all() as Array<{ key: string }>).map(
        (r) => r.key,
      ),
    );
    // Reglas de ignorar y avisos descartados. Salvaguarda fija: un pago o plazo con hora
    // a menos de 2 h se avisa siempre, esté ignorado o con regla.
    initIgnoreStore(deps.db);
    const ignore = loadIgnoreState(deps.db);
    const ignoredByRule = (item: AgendaItem): boolean =>
      ruleSuppresses(ignore, item) && !isCritical(item, nowMs);
    const ignoredOccurrence = (item: AgendaItem): boolean =>
      ignore.dismissedOccurrences.has(occurrenceKey(item)) && !isCritical(item, nowMs);
    // Horas de silencio: lo no crítico espera SIN marcarse, y sale al terminar.
    const quiet = deps.quiet ? inQuietHours(nowMs, deps.quiet, timeZone) : false;
    const allowed = (item: AgendaItem): boolean => !quiet || isCritical(item, nowMs);
    const maxItems = Math.max(1, deps.maxItems ?? MAX_HALLAZGOS);

    const fresh = [...unique.entries()].filter(([key]) => !known.has(key));
    // Cap aquí, no en collectFindings: después del dedupe y del filtro de conocidos.
    // El filtro de silencio se aplica POR OCURRENCIA: se avisa (y se marca) exactamente
    // de las ocurrencias permitidas, no de las demás homónimas del mismo hallazgo.
    const toSend: Array<[string, AgendaItem[], Array<[string, AgendaItem]>]> = [];
    for (const [key, item] of fresh) {
      const occs = (occByFinding.get(key) ?? []).filter(
        ([, occ]) => allowed(occ) && !ignoredByRule(occ),
      );
      if (occs.length === 0 && allowed(item) && !occByFinding.has(key)) continue;
      if (occs.length === 0) continue;
      occs.sort((x, y) => (x[1].at ?? 0) - (y[1].at ?? 0));
      toSend.push([key, occs.map(([, o]) => o), occs]);
    }
    toSend.splice(maxItems);

    // Recordatorios: hallazgos ya avisados cuya etapa (T-24h / T-2h) ya toca y aún
    // no salió. Solo la etapa más cercana se dice; las anteriores se marcan.
    const reminders: Array<{
      key: string;
      item: AgendaItem;
      stage: ReminderStage;
      covered: ReminderStage[];
    }> = [];
    for (const [ok, item] of reminderSources) {
      if (!known.has(findingKey(item, timeZone)) || !allowed(item)) continue;
      if (ignoredByRule(item) || ignoredOccurrence(item)) continue;
      const due = dueStages(item, timeZone, nowMs);
      const pending = due.filter((st) => !marked.has(stageKey(ok, st)));
      // Etapa crítica propia: un pago o plazo con hora que ENTRA en <2h se avisa una vez
      // dentro de esa ventana aunque T-2h ya se hubiera dado antes, y no se repite.
      const critPending = isCritical(item, nowMs) && !marked.has(critKey(ok));
      const last =
        pending[pending.length - 1] ?? (critPending ? ('t2' as ReminderStage) : undefined);
      if (last) reminders.push({ key: ok, item, stage: last, covered: due });
    }
    reminders.sort((x, y) => (x.item.at ?? 0) - (y.item.at ?? 0));
    const remindersToSend = reminders.slice(0, maxItems);

    // Conflictos: solape real entre dos cosas con hora, una sola vez por par.
    // Nunca críticos: durante el silencio esperan.
    const conflicts: Conflict[] = quiet
      ? []
      : findConflicts([...occurrences.values()], occurrenceKey, nowMs)
          .filter((c) => !marked.has(c.key))
          .slice(0, MAX_CONFLICTS);

    // Cargos raros pendientes: no críticos, esperan al fin del silencio sin marcarse.
    const chargeAlerts = quiet ? [] : pendingChargeAlerts(deps.db, nowMs);
    // Descargas nuevas (solo si /ojo descargas on): tampoco críticas, esperan al silencio.
    if (deps.screenScan && !quiet && !deps.shouldAbort?.() && getScreenEnabled(deps.db)) {
      await withTimeout(
        deps.screenScan(),
        Math.max(1, deps.agendaTimeoutMs ?? AGENDA_TIMEOUT_MS),
        'vigilante: lectura de pantalla',
      ).catch((err: unknown) => {
        log.warn('vigilante: pantalla no disponible en este barrido', { err: String(err) });
      });
    }
    const screenItems = quiet ? [] : pendingScreen(deps.db, nowMs);
    const downloads = quiet ? [] : pendingDownloads(deps.db, nowMs);
    const lostInfo =
      quiet || !getDownloadsEnabled(deps.db)
        ? { lost: 0, total: 0 }
        : lostSinceReport(deps.db, deps.downloadsSuppressed?.() ?? 0);

    if (
      toSend.length === 0 &&
      remindersToSend.length === 0 &&
      conflicts.length === 0 &&
      chargeAlerts.length === 0 &&
      downloads.length === 0 &&
      screenItems.length === 0 &&
      lostInfo.lost === 0
    ) {
      return { seen: findings.length, fresh: toSend.length, notified: 0 };
    }

    // Cierre ordenado: si el daemon se apaga, este barrido no envía ni escribe.
    if (deps.shouldAbort?.()) return { seen: findings.length, fresh: toSend.length, notified: 0 };

    // Último punto de no retorno: /ojo off puede haber llegado durante cualquier espera.
    if (!getOjoEnabled(deps.db)) return zero;

    // Números de aviso: reserva durable ANTES de enviar; se confirma o se suelta.
    const findingItems = toSend.flatMap(([, items]) => items);
    const reminderItems = remindersToSend.map((r) => r.item);
    const reserved = reserveNotices(deps.db, [...findingItems, ...reminderItems], now());
    const findingNumbers = reserved.slice(0, findingItems.length);
    const reminderNumbers = reserved.slice(findingItems.length);

    const parts: string[] = [];
    if (toSend.length > 0) {
      parts.push(
        formatFindings(
          // Solo las ocurrencias permitidas, cada una con su hora: lo que se marca
          // como cubierto es exactamente lo que el aviso dice.
          findingItems,
          timeZone,
          findingNumbers,
        ),
      );
    }
    if (remindersToSend.length > 0) {
      parts.push(formatReminders(remindersToSend, nowMs, timeZone, reminderNumbers));
    }
    if (conflicts.length > 0) parts.push(formatConflicts(conflicts, timeZone, MAX_TITULO));
    if (chargeAlerts.length > 0) parts.push(formatChargeAlerts(chargeAlerts, timeZone));
    if (downloads.length > 0 || lostInfo.lost > 0) {
      parts.push(formatDownloads(downloads, lostInfo.lost));
    }

    if (screenItems.length > 0) parts.push(formatScreen(screenItems));

    let sent = false;
    try {
      sent = await deps.send(parts.join('\n\n'));
    } catch (err) {
      log.warn('vigilante: envío fallido, se reintenta en el próximo barrido', {
        err: String(err),
      });
    }
    if (!sent) {
      releaseNotices(deps.db, reserved);
      return { seen: findings.length, fresh: toSend.length, notified: 0 };
    }

    // Una entrega CONFIRMADA se persiste siempre, también durante el cierre: el
    // drain de stop() espera a este barrido antes de que cli.ts cierre las bases
    // de datos. Marcarla evita que el mismo aviso reaparezca al reiniciar.
    const insert = deps.db.prepare(
      'INSERT OR IGNORE INTO vigilante_seen (key, kind, title, at, notified_at) VALUES (?, ?, ?, ?, ?)',
    );
    const mark = deps.db.prepare(
      'INSERT OR IGNORE INTO vigilante_stages (key, kind, title, at, notified_at) VALUES (?, ?, ?, ?, ?)',
    );
    for (const [key, items, occs] of toSend) {
      const first = items[0] as AgendaItem;
      insert.run(key, first.kind, first.title, first.at ?? null, now());
      // El aviso de descubrimiento cubre las etapas vigentes de las ocurrencias que dice.
      for (const [ok, occ] of occs) {
        for (const st of dueStages(occ, timeZone, nowMs)) {
          mark.run(stageKey(ok, st), `etapa:${st}`, occ.title, occ.at ?? null, now());
        }
        if (isCritical(occ, nowMs)) {
          mark.run(critKey(ok), 'etapa:crit', occ.title, occ.at ?? null, now());
        }
      }
    }
    for (const r of remindersToSend) {
      for (const st of r.covered) {
        mark.run(stageKey(r.key, st), `etapa:${st}`, r.item.title, r.item.at ?? null, now());
      }
      if (isCritical(r.item, nowMs)) {
        mark.run(critKey(r.key), 'etapa:crit', r.item.title, r.item.at ?? null, now());
      }
    }
    confirmNotices(deps.db, reserved);
    markChargesNotified(
      deps.db,
      chargeAlerts.map((a) => a.msgId),
    );
    markDownloadsNotified(
      deps.db,
      downloads.map((d) => d.key),
    );
    markScreenNotified(
      deps.db,
      screenItems.map((i) => i.key),
    );
    if (lostInfo.lost > 0) markLostReported(deps.db, lostInfo.total);
    trackItems(
      deps.db,
      toSend.flatMap(([, , occs]) => occs.map(([, o]) => o)),
      now(),
    );
    for (const c of conflicts) {
      mark.run(c.key, 'conflicto', `${c.a.title} / ${c.b.title}`, c.a.at ?? null, now());
    }
    log.info('vigilante: avisos notificados', {
      nuevos: toSend.length,
      recordatorios: remindersToSend.length,
      conflictos: conflicts.length,
    });
    return { seen: findings.length, fresh: toSend.length, notified: toSend.length };
  } catch (err) {
    log.warn('vigilante: barrido fallido, se reintenta en el próximo ciclo', { err: String(err) });
    return zero;
  }
}

/**
 * El bucle: cadena de setTimeout, no setInterval — un barrido lento nunca apila el
 * siguiente (misma razón que en `cron/scheduler.ts`). `stop` es async: cancela el
 * siguiente tick y drena el barrido en vuelo. El barrido consulta `shouldAbort`
 * antes de enviar (durante el cierre no salen avisos nuevos); una entrega ya
 * confirmada se completa y se persiste dentro del drain, antes del db close.
 */
export function startVigilanteLoop(
  deps: VigilanteDeps,
  timeZone: string,
  intervalMs: number,
  firstDelayMs = intervalMs,
): { stop: () => Promise<void> } {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    await runVigilanteOnce({ ...deps, shouldAbort: () => stopped }, timeZone);
    if (!stopped) schedule(intervalMs);
  };
  const schedule = (ms: number): void => {
    timer = setTimeout(() => {
      timer = null;
      inFlight = tick();
    }, ms);
  };
  schedule(firstDelayMs);
  return {
    stop: async () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (inFlight) await inFlight;
    },
  };
}
