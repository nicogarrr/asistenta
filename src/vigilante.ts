/**
 * El ojo de águila: avisar de lo nuevo sin que se le pida.
 *
 * Un asistente que solo responde obliga al usuario a acordarse de preguntar. Este
 * módulo hace el barrido contrario: cada cierto tiempo mira la agenda unificada
 * (calendario + correo + pendientes, vía `buildAgenda`) y avisa por Telegram de lo
 * que APARECE de nuevo — un deadline en un correo, un pago próximo, un viaje.
 *
 * Tres reglas hacen que el aviso sea de fiar y no ruido:
 *
 * 1. **Cada hallazgo se notifica UNA vez.** La clave es estable (tipo + título
 *    normalizado + día), guardada en sqlite. Un mismo evento redescubierto en cada
 *    barrido no vuelve a molestar: la confianza se pierde la primera vez que el
 *    asistente repite algo que ya dijo.
 * 2. **Sin fecha no hay hallazgo.** El extractor de agenda ya se niega a inventar
 *    fechas; el vigilante además descarta lo que no tiene `at`, porque "algo sin
 *    fecha" como aviso es un rumor, no un dato.
 * 3. **El envío fallido se reintenta, no se olvida.** Solo se marca como notificado
 *    lo que Telegram confirmó; un fallo de red deja el hallazgo pendiente para el
 *    siguiente barrido, igual que los recordatorios de `cli.ts`.
 *
 * El barrido es barato y sin LLM: la inteligencia (qué es un deadline, qué es ruido)
 * vive en `src/agenda/extract.ts`, que ya está probada. Aquí solo hay diff + formato.
 */

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AgendaItem, AgendaKind, UnifiedAgenda } from './agenda/unified.js';
import { log } from './log.js';

/** Tipos que merecen aviso proactivo. `reminder`/`other` no: o ya avisa otro, o es ruido. */
export const VIGILANTE_KINDS: readonly AgendaKind[] = ['deadline', 'payment', 'travel', 'meeting'];

/** Tope de hallazgos por aviso: un digest de 30 líneas no se lee, se silencia. */
export const MAX_HALLAZGOS = 5;

export interface VigilanteDeps {
  /** La agenda unificada ya construida (fuentes inyectadas fuera, testeable). */
  agenda: () => Promise<UnifiedAgenda>;
  /** Entrega el texto; devuelve si llegó. */
  send: (text: string) => Promise<boolean>;
  db: DatabaseSync;
  now?: () => number;
  maxItems?: number;
}

export interface VigilanteResult {
  /** Hallazgos candidatos vistos en este barrido. */
  seen: number;
  /** Hallazgos nuevos de verdad. */
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
 * Clave estable de un hallazgo: tipo + título normalizado + DÍA (no el instante).
 * El mismo evento redescubierto a otra hora del mismo día es el mismo hallazgo;
 * sin el día, dos escaneos del mismo correo notificarían dos veces.
 */
export function findingKey(item: AgendaItem): string {
  const title = item.title.trim().toLowerCase().replace(/\s+/g, ' ');
  const day = item.at == null ? 'sin-fecha' : new Date(item.at).toISOString().slice(0, 10);
  return createHash('sha256').update(`${item.kind}|${day}|${title}`).digest('hex').slice(0, 24);
}

/**
 * Candidatos de la agenda: con fecha conocida, de un tipo que merece aviso,
 * ordenados por cuándo tocan y capados. Los de hoy primero (ya los ordena la agenda).
 */
export function collectFindings(agenda: UnifiedAgenda, maxItems = MAX_HALLAZGOS): AgendaItem[] {
  return [...agenda.today, ...agenda.upcoming]
    .filter((item) => item.at != null && VIGILANTE_KINDS.includes(item.kind))
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
    .slice(0, Math.max(1, maxItems));
}

const KIND_LABEL: Record<string, string> = {
  deadline: 'Plazo',
  payment: 'Pago',
  travel: 'Viaje',
  meeting: 'Cita',
};

function formatWhen(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat('es-ES', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(new Date(at));
}

/** Digest en español, una línea por hallazgo, sin prometer más que lo que la agenda vio. */
export function formatFindings(items: AgendaItem[], timeZone: string): string {
  const lines = items.map((item) => {
    const label = KIND_LABEL[item.kind] ?? item.kind;
    const when = item.at == null ? 'sin fecha' : formatWhen(item.at, timeZone);
    return `• ${label}: ${item.title} — ${when}`;
  });
  const header =
    items.length === 1
      ? '🦅 Ojo de águila: 1 cosa nueva'
      : `🦅 Ojo de águila: ${items.length} cosas nuevas`;
  return `${header}\n${lines.join('\n')}`;
}

/**
 * Un barrido: construye la agenda, difiere contra lo ya notificado y avisa solo de
 * lo nuevo. Nunca lanza: una fuente rota deja nota en el log y el siguiente barrido
 * lo intenta de nuevo — el vigilante no puede ser lo que tumbe el daemon.
 */
export async function runVigilanteOnce(
  deps: VigilanteDeps,
  timeZone: string,
): Promise<VigilanteResult> {
  initVigilanteStore(deps.db);
  const now = deps.now ?? Date.now;
  let agenda: UnifiedAgenda;
  try {
    agenda = await deps.agenda();
  } catch (err) {
    log.warn('vigilante: no se pudo construir la agenda', { err: String(err) });
    return { seen: 0, fresh: 0, notified: 0 };
  }

  const findings = collectFindings(agenda, deps.maxItems);
  if (findings.length === 0) return { seen: 0, fresh: 0, notified: 0 };

  const known = new Set(
    (deps.db.prepare('SELECT key FROM vigilante_seen').all() as Array<{ key: string }>).map(
      (r) => r.key,
    ),
  );
  const fresh = findings.filter((item) => !known.has(findingKey(item)));
  if (fresh.length === 0) return { seen: findings.length, fresh: 0, notified: 0 };

  let sent = false;
  try {
    sent = await deps.send(formatFindings(fresh, timeZone));
  } catch (err) {
    log.warn('vigilante: envío fallido, se reintenta en el próximo barrido', { err: String(err) });
  }
  if (!sent) return { seen: findings.length, fresh: fresh.length, notified: 0 };

  const insert = deps.db.prepare(
    'INSERT OR IGNORE INTO vigilante_seen (key, kind, title, at, notified_at) VALUES (?, ?, ?, ?, ?)',
  );
  for (const item of fresh) {
    insert.run(findingKey(item), item.kind, item.title, item.at ?? null, now());
  }
  log.info('vigilante: hallazgos nuevos notificados', { count: fresh.length });
  return { seen: findings.length, fresh: fresh.length, notified: fresh.length };
}

/**
 * El bucle: cadena de setTimeout, no setInterval — un barrido lento nunca apila el
 * siguiente (misma razón que en `cron/scheduler.ts`). `stop` cancela el siguiente tick.
 */
export function startVigilanteLoop(
  deps: VigilanteDeps,
  timeZone: string,
  intervalMs: number,
  firstDelayMs = intervalMs,
): { stop: () => void } {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    await runVigilanteOnce(deps, timeZone).catch((err: unknown) => {
      log.warn('vigilante: barrido fallido', { err: String(err) });
    });
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
  };
  timer = setTimeout(() => void tick(), firstDelayMs);
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
