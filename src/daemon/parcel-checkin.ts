/**
 * Un paquete «en reparto» llega hoy. Si a última hora sigue sin «entregado», Asistenta
 * pregunta UNA vez, como haría una persona: «¿Te llegó el paquete de InPost?». Un «sí»
 * lo marca como entregado; un «no» lo deja en marcha. Sin insistir y fuera de las horas
 * de silencio. Lee los repartos que ya se guardan de los correos (src/mail/deliveries.ts);
 * no cambia cómo se leen.
 */
import type { DatabaseSync } from 'node:sqlite';
import { wallClock, zonedTime } from '../datecontext.js';
import { activeDeliveries, type Delivery, markDeliveryCollected } from '../mail/deliveries.js';

/** «En reparto» es «llega hoy»: pasada esta hora local sin entregar, se pregunta. */
export const PARCEL_CHECKIN_HOUR = 21;
/** Si el aviso de reparto llegó tarde, al menos esto después. */
export const PARCEL_CHECKIN_MIN_WAIT_MS = 3 * 3_600_000;
/** Pasado esto ya no se pregunta: sería raro sacarlo ahora. */
export const PARCEL_CHECKIN_MAX_AGE_MS = 2 * 24 * 3_600_000;
/** Cuánto vale un «sí» / «no» después de preguntar. */
export const PARCEL_ANSWER_WINDOW_MS = 12 * 3_600_000;

/** Cuándo toca preguntar por un paquete que salió a reparto en `statusAt`. */
export function parcelCheckInAt(statusAt: number, timeZone?: string): number {
  const d = wallClock(new Date(statusAt), timeZone);
  const evening = zonedTime(d.year, d.month, d.day, PARCEL_CHECKIN_HOUR, 0, timeZone);
  return Math.max(evening, statusAt + PARCEL_CHECKIN_MIN_WAIT_MS);
}

/** El paquete por el que toca preguntar, o null. */
export function pickParcelCheckIn(
  list: readonly Delivery[],
  now: number,
  asked: (d: Delivery) => boolean,
  timeZone?: string,
): Delivery | null {
  let best: Delivery | null = null;
  for (const d of list) {
    if (d.status !== 'en_reparto') continue;
    if (now < parcelCheckInAt(d.statusAt, timeZone)) continue;
    if (now - d.statusAt > PARCEL_CHECKIN_MAX_AGE_MS || asked(d)) continue;
    if (!best || d.statusAt < best.statusAt) best = d;
  }
  return best;
}

/** «InPost», o el asunto si la tienda no dice transportista. */
function parcelName(d: Delivery): string {
  if (d.carrier !== 'tienda') return d.carrier;
  const t = d.title.replace(/\s+/g, ' ').trim();
  return `«${t.length > 60 ? `${t.slice(0, 59).trimEnd()}…` : t}»`;
}

export function parcelCheckInLine(d: Delivery): string {
  return `¿Te llegó el paquete de ${parcelName(d)}? Dime «sí» y lo doy por entregado.`;
}

const YES =
  /^(?:s[ií]|ya|ya lo tengo|ya ha llegado|ya lleg[oó]|lleg[oó]|ha llegado|me lleg[oó]|lo tengo|s[ií],? (?:ya|lleg[oó]|lo tengo|ya lo tengo|ha llegado))(?:\s*,?\s*gracias)?[.!\s]*$/iu;
const NO =
  /^(?:no|todav[ií]a no|a[uú]n no|no,? (?:todav[ií]a|a[uú]n) no|no ha llegado|no lleg[oó]|no me ha llegado)[.!\s]*$/iu;

export type ParcelAnswer = 'entregado' | 'no' | null;

/** Las preguntas ya hechas, en la misma base que los repartos (sobrevive a reinicios). */
function initAsked(db: DatabaseSync): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS delivery_checkins (key TEXT NOT NULL, status_at INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (key, status_at))',
  );
}

export interface ParcelCheckInDeps {
  db: DatabaseSync;
  /** Manda al DM del dueño; false si no se pudo. */
  send: (text: string) => Promise<boolean>;
  now: () => number;
  /** Horas de silencio del dueño. */
  quiet: (now: number) => boolean;
  enabled: () => boolean;
  timeZone?: () => string;
}

export class ParcelCheckIn {
  #asked: { key: string; at: number } | null = null;
  readonly #deps: ParcelCheckInDeps;

  constructor(deps: ParcelCheckInDeps) {
    this.#deps = deps;
  }

  /** Un tic: pregunta por un paquete si toca. Devuelve el texto enviado, o null. */
  async tick(): Promise<string | null> {
    const d = this.#deps;
    if (!d.enabled()) return null;
    const now = d.now();
    if (d.quiet(now)) return null;
    initAsked(d.db);
    const seen = d.db.prepare('SELECT 1 FROM delivery_checkins WHERE key = ? AND status_at = ?');
    const p = pickParcelCheckIn(
      activeDeliveries(d.db, now),
      now,
      (x) => seen.get(x.key, x.statusAt) !== undefined,
      d.timeZone?.(),
    );
    if (!p) return null;
    // Se apunta ANTES de enviar: mejor una pregunta perdida que dos iguales.
    d.db
      .prepare('INSERT OR IGNORE INTO delivery_checkins (key, status_at, at) VALUES (?, ?, ?)')
      .run(p.key, p.statusAt, now);
    d.db.prepare('DELETE FROM delivery_checkins WHERE at < ?').run(now - 60 * 86_400_000);
    const text = parcelCheckInLine(p);
    if (!(await d.send(text).catch(() => false))) return null;
    this.#asked = { key: p.key, at: now };
    return text;
  }

  /**
   * El dueño ha escrito: si contesta a la pregunta poco después, «sí» lo marca como
   * entregado y «no» lo deja como está. Solo cuenta el mensaje siguiente a la pregunta:
   * si habla de otra cosa, un «sí» de después ya no es para el paquete.
   */
  answered(text: string, now = this.#deps.now()): ParcelAnswer {
    const asked = this.#asked;
    if (!asked || now - asked.at > PARCEL_ANSWER_WINDOW_MS) return null;
    const t = text.trim();
    if (NO.test(t)) {
      this.#asked = null;
      return 'no';
    }
    this.#asked = null;
    if (!YES.test(t)) return null;
    markDeliveryCollected(this.#deps.db, '', now, asked.key);
    return 'entregado';
  }
}

/** Lo que se le contesta al «sí» / «no». */
export function parcelAnswerReply(answer: Exclude<ParcelAnswer, null>): string {
  return answer === 'entregado'
    ? 'Genial, lo doy por entregado.'
    : 'Vaya. Lo dejo en marcha y te aviso si el correo dice algo nuevo.';
}
