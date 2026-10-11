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
 *    Sin un DM único y verificado (allowlist), el hallazgo espera.
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

/** Tipos que merecen aviso proactivo. `reminder`/`other` no: o ya avisa otro, o es ruido. */
export const VIGILANTE_KINDS: readonly AgendaKind[] = ['deadline', 'payment', 'travel', 'meeting'];

/** Tope de hallazgos por aviso: un digest de 30 líneas no se lee, se silencia. */
export const MAX_HALLAZGOS = 5;

/** Tope de título, como en la agenda: un asunto de correo no acotado infla el digest. */
export const MAX_TITULO = 90;

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
   * Cierre ordenado: se consulta antes de enviar y antes de persistir. Si el daemon
   * se está apagando, el barrido en vuelo termina SIN enviar ni escribir — la base
   * de datos puede morir justo después.
   */
  shouldAbort?: () => boolean;
}

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
    CREATE TABLE IF NOT EXISTS vigilante_seen (
      key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      at INTEGER,
      notified_at INTEGER NOT NULL
    )
  `);
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
  return [...agenda.today, ...agenda.upcoming, ...pendingVigente]
    .filter((item) => item.at != null && VIGILANTE_KINDS.includes(item.kind))
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}

/**
 * El DM del owner, o null. Un chatId de Telegram positivo es un DM; los grupos y
 * canales son negativos, y un grupo con un usuario permitido dentro sigue siendo
 * una audiencia que no pidió la agenda privada del owner. La allowlist del canal es
 * la prueba de que el DM es del owner. Cero candidatos o más de uno: null — cerrado.
 */
export function resolveOwnerDmChatId(
  chatKeys: Iterable<string>,
  allowedUserIds: readonly number[],
): string | null {
  const candidates = new Set<string>();
  for (const key of chatKeys) {
    const [channel, , chatId] = key.split(':');
    if (channel !== 'telegram' || !chatId) continue;
    const id = Number(chatId);
    // DMs de usuario: entero positivo. Grupos, supergrupos y canales: negativos.
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    if (!allowedUserIds.includes(id)) continue;
    candidates.add(chatId);
  }
  if (candidates.size !== 1) return null;
  return [...candidates][0] ?? null;
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
export function formatFindings(items: AgendaItem[], timeZone: string): string {
  const lines = items.map((item) => {
    const label = KIND_LABEL[item.kind] ?? item.kind;
    const title = item.title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITULO) || '(sin título)';
    const tag =
      item.sources && item.sources.length > 1
        ? item.sources.map((where) => WHERE_TAG[where] ?? where).join('+')
        : (WHERE_TAG[item.where] ?? item.where);
    const doubt =
      item.confidence !== undefined && item.confidence < 0.8
        ? ` (${Math.round(item.confidence * 100)}% seguro)`
        : '';
    return `• ${label}: ${title} — ${formatWhen(item, timeZone)} (${tag})${doubt}`;
  });
  const header =
    items.length === 1
      ? '🦅 Ojo de águila: 1 cosa nueva'
      : `🦅 Ojo de águila: ${items.length} cosas nuevas`;
  return `${header}\n${lines.join('\n')}`;
}

/**
 * Un barrido: construye la agenda, difiere contra lo ya notificado y avisa solo de
 * lo nuevo. El cap se aplica DESPUÉS de descartar lo ya visto: capar antes dejaría
 * los hallazgos 6+ sin avisar hasta que venzan los primeros. No lanza nunca: una
 * fuente rota, una base de datos cerrada o un envío fallido dejan nota en el log y
 * el siguiente barrido lo intenta de nuevo.
 */
export async function runVigilanteOnce(
  deps: VigilanteDeps,
  timeZone: string,
): Promise<VigilanteResult> {
  const zero: VigilanteResult = { seen: 0, fresh: 0, notified: 0 };
  try {
    initVigilanteStore(deps.db);
    const now = deps.now ?? Date.now;
    const agenda = await deps.agenda();

    const findings = collectFindings(agenda, timeZone, now());
    if (findings.length === 0) return zero;

    // Dedupe intra-barrido: dos fuentes pueden traer el mismo hallazgo dos veces y
    // el digest diría la misma cosa en dos bullets.
    const unique = new Map<string, AgendaItem>();
    for (const item of findings) {
      const key = findingKey(item, timeZone);
      if (!unique.has(key)) unique.set(key, item);
    }

    const known = new Set(
      (deps.db.prepare('SELECT key FROM vigilante_seen').all() as Array<{ key: string }>).map(
        (r) => r.key,
      ),
    );
    const fresh = [...unique.values()].filter((item) => !known.has(findingKey(item, timeZone)));
    if (fresh.length === 0) return { seen: findings.length, fresh: 0, notified: 0 };

    // Cap aquí, no en collectFindings: después del dedupe y del filtro de conocidos.
    const maxItems = Math.max(1, deps.maxItems ?? MAX_HALLAZGOS);
    const toSend = fresh.slice(0, maxItems);

    // Cierre ordenado: si el daemon se apaga, este barrido no envía ni escribe.
    if (deps.shouldAbort?.()) return { seen: findings.length, fresh: toSend.length, notified: 0 };

    let sent = false;
    try {
      sent = await deps.send(formatFindings(toSend, timeZone));
    } catch (err) {
      log.warn('vigilante: envío fallido, se reintenta en el próximo barrido', {
        err: String(err),
      });
    }
    if (!sent) return { seen: findings.length, fresh: toSend.length, notified: 0 };
    if (deps.shouldAbort?.()) return { seen: findings.length, fresh: toSend.length, notified: 0 };

    const insert = deps.db.prepare(
      'INSERT OR IGNORE INTO vigilante_seen (key, kind, title, at, notified_at) VALUES (?, ?, ?, ?, ?)',
    );
    for (const item of toSend) {
      insert.run(findingKey(item, timeZone), item.kind, item.title, item.at ?? null, now());
    }
    log.info('vigilante: hallazgos nuevos notificados', { count: toSend.length });
    return { seen: findings.length, fresh: toSend.length, notified: toSend.length };
  } catch (err) {
    log.warn('vigilante: barrido fallido, se reintenta en el próximo ciclo', { err: String(err) });
    return zero;
  }
}

/**
 * El bucle: cadena de setTimeout, no setInterval — un barrido lento nunca apila el
 * siguiente (misma razón que en `cron/scheduler.ts`). `stop` es async: cancela el
 * siguiente tick y drena el barrido en vuelo, que además consulta `shouldAbort`
 * antes de enviar y de escribir, así nada se envía ni se persiste tras el cierre.
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
