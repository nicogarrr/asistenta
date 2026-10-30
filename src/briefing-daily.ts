/**
 * El resumen de la mañana, cableado de verdad: decide si toca, junta las fuentes con
 * un tope de tiempo cada una y lo manda al DM del dueño. Todo llega por `deps` para
 * que el daemon solo tenga que enchufar sus piezas y los tests no necesiten red.
 *
 * Ritmo (que no sea spam):
 * - Apagado por defecto (`PA_BRIEFING=1` lo enciende).
 * - Una vez por día natural, a partir de `hour` (08:00 por defecto).
 * - Si el daemon despierta después de `latestHour` (12:00) sin haberlo enviado, el de
 *   hoy se da por saltado: un «buenos días» a las 19:00 es ruido, no ayuda.
 * - Un día sin nada (sin agenda, correo, pendientes ni tiempo) no se manda nada.
 * - Una fuente lenta o rota no bloquea el resto: se omite y el briefing sale igual.
 * - Solo se marca como enviado si el envío funcionó; si falla, se reintenta en el
 *   siguiente tick hasta `latestHour`.
 */

import { type BriefingInput, briefingDue, buildBriefing, watchHit } from './briefing.js';
import type { MailMessage } from './mail/types.js';
import { isReminder, reminderText } from './tools/reminder.js';

export const DEFAULT_BRIEFING_HOUR = 8;
export const DEFAULT_BRIEFING_LATEST_HOUR = 12;
export const DEFAULT_SOURCE_TIMEOUT_MS = 15_000;
const MAX_MAIL = 3;
const DAY_MS = 24 * 3_600_000;

export interface DailyBriefingDeps {
  /** ¿Encendido? Normalmente `process.env.PA_BRIEFING === '1'`. */
  enabled: () => boolean;
  now: () => Date;
  hour?: number;
  latestHour?: number;
  lastSent: () => number;
  markSent: (at: number) => void;
  /** Chat del DM del dueño verificado, o null (fail-closed: sin dueño no sale nada). */
  owner: () => string | null;
  send: (chatId: string, text: string) => Promise<boolean>;
  agenda?: () => Promise<BriefingInput['agenda']>;
  routines?: () => BriefingInput['routines'] | Promise<BriefingInput['routines']>;
  reminders?: () => BriefingInput['reminders'] | Promise<BriefingInput['reminders']>;
  followups?: () => BriefingInput['followups'] | Promise<BriefingInput['followups']>;
  weather?: () => Promise<string | null>;
  mail?: () => Promise<BriefingInput['mail']>;
  /** Objetivos activos o bloqueados del dueño. */
  goals?: () => BriefingInput['goals'] | Promise<BriefingInput['goals']>;
  /** Vigilancias de precio activas del dueño. */
  watches?: () => BriefingInput['watches'] | Promise<BriefingInput['watches']>;
  sourceTimeoutMs?: number;
  warn?: (msg: string, meta?: Record<string, unknown>) => void;
}

export type DailyBriefingStatus =
  | 'disabled'
  | 'not-due'
  | 'busy'
  | 'no-owner'
  | 'skipped-late'
  | 'skipped-empty'
  | 'sent'
  | 'send-failed';

export interface DailyBriefingResult {
  status: DailyBriefingStatus;
  text?: string;
}

export function greetingFor(now: Date): string {
  const h = now.getHours();
  if (h < 6) return 'Hola';
  if (h < 14) return 'Buenos días';
  if (h < 21) return 'Buenas tardes';
  return 'Buenas noches';
}

/** Resuelve `p` o, pasado `ms`, `fallback`. Un error también acaba en `fallback`. */
async function within<T>(
  name: string,
  p: (() => T | Promise<T>) | undefined,
  fallback: T,
  ms: number,
  warn?: DailyBriefingDeps['warn'],
): Promise<T> {
  if (!p) return fallback;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(p),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => {
          warn?.('briefing: fuente lenta, se omite', { source: name, ms });
          resolve(fallback);
        }, ms);
        timer.unref?.();
      }),
    ]);
  } catch (err) {
    warn?.('briefing: fuente falló, se omite', { source: name, err: String(err) });
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Junta las fuentes (cada una con su tope) y compone el texto. Sin efectos. */
export async function composeDailyBriefing(
  deps: DailyBriefingDeps,
): Promise<{ text: string; empty: boolean }> {
  const now = deps.now();
  const ms = deps.sourceTimeoutMs ?? DEFAULT_SOURCE_TIMEOUT_MS;
  const [agenda, routines, reminders, followups, weather, mail, goals, watches] = await Promise.all(
    [
      within('agenda', deps.agenda, [], ms, deps.warn),
      within('rutinas', deps.routines, [], ms, deps.warn),
      within('recordatorios', deps.reminders, [], ms, deps.warn),
      within('seguimientos', deps.followups, [], ms, deps.warn),
      within('tiempo', deps.weather, null, ms, deps.warn),
      within('correo', deps.mail, [], ms, deps.warn),
      within('objetivos', deps.goals, [], ms, deps.warn),
      within('precios', deps.watches, [], ms, deps.warn),
    ],
  );
  const input: BriefingInput = {
    greeting: greetingFor(now),
    today: now,
    agenda: agenda ?? [],
    routines: routines ?? [],
    reminders: reminders ?? [],
    followups: followups ?? [],
    weather: weather ?? undefined,
    mail: (mail ?? []).slice(0, MAX_MAIL),
    goals: goals ?? [],
    watches: watches ?? [],
  };
  const empty =
    !input.weather &&
    input.agenda.length === 0 &&
    input.routines.length === 0 &&
    input.reminders.length === 0 &&
    input.followups.length === 0 &&
    (input.mail?.length ?? 0) === 0 &&
    // Un objetivo en marcha o una vigilancia sin novedad no justifican un mensaje
    // por sí solos; un bloqueo (espera decisión) o un precio ya bajo el objetivo, sí.
    !(input.goals ?? []).some((g) => g.status === 'blocked') &&
    !(input.watches ?? []).some(watchHit);
  return { text: buildBriefing(input), empty };
}

let inFlight = false;

/** Un tick del daemon: manda el briefing si toca. Nunca lanza. */
export async function runDailyBriefingIfDue(deps: DailyBriefingDeps): Promise<DailyBriefingResult> {
  if (!deps.enabled()) return { status: 'disabled' };
  const now = deps.now();
  const hour = deps.hour ?? DEFAULT_BRIEFING_HOUR;
  const last = deps.lastSent();
  if (!briefingDue(last > 0 ? last : undefined, now, hour)) return { status: 'not-due' };
  if (inFlight) return { status: 'busy' };
  inFlight = true;
  try {
    const latest = Math.max(hour + 1, deps.latestHour ?? DEFAULT_BRIEFING_LATEST_HOUR);
    if (now.getHours() >= latest) {
      // Tarde para un resumen de la mañana: se salta el de hoy sin escribir nada.
      deps.markSent(now.getTime());
      return { status: 'skipped-late' };
    }
    const chatId = deps.owner();
    if (!chatId) return { status: 'no-owner' };
    const { text, empty } = await composeDailyBriefing(deps);
    if (empty) {
      deps.markSent(now.getTime());
      return { status: 'skipped-empty', text };
    }
    const ok = await deps.send(chatId, text).catch((err: unknown) => {
      deps.warn?.('briefing: envío falló', { err: String(err) });
      return false;
    });
    if (!ok) return { status: 'send-failed', text };
    deps.markSent(now.getTime());
    return { status: 'sent', text };
  } finally {
    inFlight = false;
  }
}

/** Hora local `HH:MM` de un instante, en la zona dada (Europe/Madrid en el PC de Nico). */
export function hhmm(at: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(at));
}

/** Los elementos de HOY de la agenda unificada, en líneas para el briefing. */
export function agendaTodayLines(
  items: ReadonlyArray<{ at: number | null; title: string; timed?: boolean; allDay?: boolean }>,
  timeZone?: string,
): BriefingInput['agenda'] {
  return items.map((i) => ({
    title: i.title,
    when:
      i.allDay || i.at === null ? 'todo el día' : i.timed === false ? 'hoy' : hhmm(i.at, timeZone),
  }));
}

const BULK_FROM =
  /(no-?reply|noreply|newsletter|news@|marketing|promo|notificaciones?@|notifications?@|mailer-daemon|info@|hello@|comunicaciones@)/i;
const BULK_SUBJECT =
  /(oferta|descuento|rebajas|newsletter|bolet[ií]n|webinar|black friday|cyber monday|\d+\s?% ?(dto|de descuento|off)|promoci[oó]n|suscripci[oó]n semanal)/i;

/** Nombre visible del remitente: `"Ana Pérez" <ana@x.es>` → `Ana Pérez`. */
export function senderName(from: string): string {
  const m = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/.exec(from);
  const name = (m?.[1] ?? from).trim();
  return name || from.trim();
}

/**
 * Correo que merece salir en el briefing: sin leer, de las últimas 24 h, sin
 * boletines ni promociones obvias, el más reciente primero, como mucho 3.
 * Solo remitente y asunto: el cuerpo nunca entra en el mensaje.
 */
export function pickImportantMail(
  messages: ReadonlyArray<Pick<MailMessage, 'from' | 'subject' | 'at' | 'seen'>>,
  now: number,
  max = MAX_MAIL,
): Array<{ from: string; subject: string }> {
  return messages
    .filter((m) => !m.seen)
    .filter((m) => Number.isFinite(m.at) && m.at <= now + 60_000 && now - m.at <= DAY_MS)
    .filter((m) => !BULK_FROM.test(m.from) && !BULK_SUBJECT.test(m.subject))
    .sort((a, b) => b.at - a.at)
    .slice(0, max)
    .map((m) => ({ from: senderName(m.from), subject: m.subject }));
}

/** Códigos WMO de Open-Meteo, en español llano. */
export function weatherCodeEs(code: number): string {
  if (code === 0) return 'despejado';
  if (code <= 2) return 'poco nuboso';
  if (code === 3) return 'nublado';
  if (code === 45 || code === 48) return 'niebla';
  if (code >= 51 && code <= 57) return 'llovizna';
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'lluvia';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'nieve';
  if (code >= 95) return 'tormenta';
  return 'variable';
}

export interface WeatherConfig {
  latitude: number;
  longitude: number;
  /** Etiqueta para la línea («Madrid»). Opcional. */
  label?: string;
}

/** Lee `PA_BRIEFING_LAT`/`PA_BRIEFING_LON`/`PA_BRIEFING_PLACE`. Sin coordenadas válidas, null. */
export function weatherConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WeatherConfig | null {
  const lat = Number.parseFloat(String(env.PA_BRIEFING_LAT ?? '').replace(',', '.'));
  const lon = Number.parseFloat(String(env.PA_BRIEFING_LON ?? '').replace(',', '.'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const label = String(env.PA_BRIEFING_PLACE ?? '')
    .trim()
    .slice(0, 40);
  return { latitude: lat, longitude: lon, ...(label ? { label } : {}) };
}

/**
 * El tiempo de hoy con Open-Meteo (gratis, sin clave). Devuelve una línea o null si
 * no hay datos; los errores de red se propagan para que el llamante los registre.
 */
export async function fetchWeatherLine(
  cfg: WeatherConfig,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 8_000,
): Promise<string | null> {
  const url =
    'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${cfg.latitude}&longitude=${cfg.longitude}` +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
    '&timezone=auto&forecast_days=1';
  const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`el servicio del tiempo ha respondido ${res.status}`);
  const body = (await res.json()) as {
    daily?: {
      weather_code?: number[];
      temperature_2m_max?: number[];
      temperature_2m_min?: number[];
      precipitation_probability_max?: Array<number | null>;
    };
  };
  const d = body.daily;
  const max = d?.temperature_2m_max?.[0];
  const min = d?.temperature_2m_min?.[0];
  const code = d?.weather_code?.[0];
  if (typeof max !== 'number' || typeof min !== 'number') return null;
  const parts = [`${Math.round(min)}–${Math.round(max)} °C`];
  const sky = typeof code === 'number' ? weatherCodeEs(code) : '';
  const rain = d?.precipitation_probability_max?.[0];
  const wet = sky === 'lluvia' || sky === 'llovizna' || sky === 'tormenta';
  if (typeof rain === 'number' && rain >= 30) {
    parts.push(
      wet
        ? `${sky} (${Math.round(rain)} %)`
        : `${sky ? `${sky}, ` : ''}${Math.round(rain)} % de lluvia`,
    );
  } else if (sky) parts.push(sky);
  return `Tiempo${cfg.label ? ` en ${cfg.label}` : ''}: ${parts.join(', ')}`;
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Rutinas y recordatorios que van a dispararse HOY (de ahora a medianoche), según el
 * runner en vivo. Las desactivadas y las que no tienen próxima ejecución no salen.
 */
export function scheduledForToday(
  routines: ReadonlyArray<{
    name: string;
    prompt?: string | null;
    enabled: boolean;
    next: string | null;
  }>,
  now: Date,
  timeZone?: string,
): { routines: BriefingInput['routines']; reminders: BriefingInput['reminders'] } {
  const out = {
    routines: [] as BriefingInput['routines'],
    reminders: [] as BriefingInput['reminders'],
  };
  const today = routines
    .filter((r) => r.enabled && r.next)
    .map((r) => ({ r, at: Date.parse(r.next ?? '') }))
    .filter(
      ({ at }) => Number.isFinite(at) && at >= now.getTime() && sameLocalDay(new Date(at), now),
    )
    .sort((a, b) => a.at - b.at);
  for (const { r, at } of today) {
    if (isReminder(r))
      out.reminders.push({
        text: reminderText({ name: r.name, prompt: r.prompt ?? null }),
        at: hhmm(at, timeZone),
      });
    else out.routines.push({ name: r.name, nextRun: hhmm(at, timeZone) });
  }
  return out;
}

/** Seguimientos pendientes que vencen hoy o ya vencieron (los más viejos primero, máx. 5). */
export function followupsDue(
  items: ReadonlyArray<{ subject: string; dueAt: number; status: string }>,
  now: Date,
): BriefingInput['followups'] {
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return items
    .filter((f) => f.status === 'pending' && Number.isFinite(f.dueAt) && f.dueAt <= end.getTime())
    .sort((a, b) => a.dueAt - b.dueAt)
    .slice(0, 5)
    .map((f) => ({
      subject: f.subject,
      due: f.dueAt < now.getTime() && !sameLocalDay(new Date(f.dueAt), now) ? 'vencido' : 'hoy',
    }));
}

/** Solo para tests: libera el cerrojo de envío en curso. */
export function _resetDailyBriefingForTests(): void {
  inFlight = false;
}
