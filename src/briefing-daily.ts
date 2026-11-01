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
import { localDay, wallClock, zonedTime } from './datecontext.js';
import { looksLikePhishing, phishingSignals } from './mail/triage.js';
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
  /**
   * PA_BRIEFING_VOZ=1: manda además el resumen como nota de voz, después del texto y
   * sin esperarla. Solo se llama si el texto salió bien.
   */
  speak?: (chatId: string, text: string, signal?: AbortSignal) => Promise<void>;
  /** Objetivos activos o bloqueados del dueño. */
  goals?: () => BriefingInput['goals'] | Promise<BriefingInput['goals']>;
  /** Tareas del tablero del dueño: hoy sin hacer y atrasadas. */
  tasks?: () => BriefingInput['tasks'] | Promise<BriefingInput['tasks']>;
  /** Paquetes en camino, sacados de los correos de envío. */
  deliveries?: () => BriefingInput['deliveries'] | Promise<BriefingInput['deliveries']>;
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
  const h = wallClock(now).hour;
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
  const [agenda, routines, reminders, followups, weather, mail, goals, watches, tasks, deliveries] =
    await Promise.all([
      within('agenda', deps.agenda, [], ms, deps.warn),
      within('rutinas', deps.routines, [], ms, deps.warn),
      within('recordatorios', deps.reminders, [], ms, deps.warn),
      within('seguimientos', deps.followups, [], ms, deps.warn),
      within('tiempo', deps.weather, null, ms, deps.warn),
      within('correo', deps.mail, [], ms, deps.warn),
      within('objetivos', deps.goals, [], ms, deps.warn),
      within('precios', deps.watches, [], ms, deps.warn),
      within('tareas', deps.tasks, [], ms, deps.warn),
      within('repartos', deps.deliveries, [], ms, deps.warn),
    ]);
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
    tasks: tasks ?? [],
    deliveries: deliveries ?? [],
  };
  const empty =
    !input.weather &&
    input.agenda.length === 0 &&
    (input.tasks?.length ?? 0) === 0 &&
    // Un paquete «enviado» no justifica el mensaje; en reparto o con incidencia, sí.
    !(input.deliveries ?? []).some((d) => d.notable) &&
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
/**
 * La voz va DESPUÉS del texto y sin esperarla: un TTS lento o roto nunca
 * retrasa ni impide el resumen escrito, ni hace que se reenvíe.
 */
function speakAfterText(deps: DailyBriefingDeps, chatId: string, text: string): void {
  if (!deps.speak) return;
  const ctl = new AbortController();
  let set = pendingVoice.get(chatId);
  if (!set) {
    set = new Set();
    pendingVoice.set(chatId, set);
  }
  set.add(ctl);
  void Promise.resolve()
    .then(() => deps.speak?.(chatId, text, ctl.signal))
    .catch((err: unknown) => deps.warn?.('briefing: voz falló', { err: String(err) }))
    .finally(() => {
      const s = pendingVoice.get(chatId);
      s?.delete(ctl);
      if (s && s.size === 0) pendingVoice.delete(chatId);
    });
}

/** Notas de voz del resumen que aún se están preparando, por chat. */
const pendingVoice = new Map<string, Set<AbortController>>();

/**
 * /stop: la nota de voz del resumen tarda unos segundos en sintetizarse y llegaba
 * después de «Detenido.». Esto la cancela si aún no ha salido. Devuelve cuántas paró.
 */
export function stopBriefingVoice(chatId: string): number {
  const set = pendingVoice.get(chatId);
  if (!set) return 0;
  let n = 0;
  for (const ctl of set) {
    if (!ctl.signal.aborted) {
      ctl.abort();
      n++;
    }
  }
  pendingVoice.delete(chatId);
  return n;
}

/**
 * La voz del resumen (PA_BRIEFING_VOZ): sintetiza y manda la nota, salvo que /stop
 * la haya cancelado mientras se sintetizaba.
 */
export function briefingSpeaker<A>(opts: {
  synth: (text: string) => Promise<A | null | undefined>;
  send: (chatId: string, audio: A) => Promise<unknown>;
}): (chatId: string, text: string, signal?: AbortSignal) => Promise<void> {
  return async (chatId, text, signal) => {
    if (signal?.aborted) return;
    const audio = await opts.synth(text);
    if (!audio || signal?.aborted) return;
    await opts.send(chatId, audio);
  };
}

/**
 * `/resumen hoy`: la misma composición que el de la mañana, sin tocar su ritmo
 * (ni lastSent ni markSent). Con PA_BRIEFING_VOZ (deps.speak) también sale como
 * nota de voz, con la misma regla: después del texto, solo si el texto salió, y
 * sin esperarla.
 */
export async function answerBriefingOnDemand(
  deps: DailyBriefingDeps,
  chatId: string,
  reply: (text: string) => Promise<unknown>,
): Promise<string> {
  const { text } = await composeDailyBriefing(deps);
  await reply(text);
  speakAfterText(deps, chatId, text);
  return text;
}

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
    if (wallClock(now).hour >= latest) {
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
    speakAfterText(deps, chatId, text);
    return { status: 'sent', text };
  } finally {
    inFlight = false;
  }
}

/**
 * Cada cuánto se mira si toca el resumen diario. Antes solo se miraba en el reloj de
 * 2 h de las vigilancias de páginas: el resumen de las 8 llegaba hasta 2 h tarde y,
 * si el PC arrancaba después de las 10, la primera mirada caía pasadas las 12 y el
 * resumen de ese día se saltaba entero. Comprobar es barato: no llama al modelo.
 */
export const BRIEFING_CHECK_EVERY_MS = 60_000;

/** Arranca la comprobación periódica del resumen diario. Devuelve cómo pararla. */
export function startDailyBriefingTimer(
  deps: DailyBriefingDeps,
  everyMs: number = BRIEFING_CHECK_EVERY_MS,
): () => void {
  const timer = setInterval(() => {
    runDailyBriefingIfDue(deps).catch((err: unknown) => {
      deps.warn?.('briefing: comprobación falló', { err: String(err) });
    });
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
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
  messages: ReadonlyArray<
    Pick<MailMessage, 'from' | 'subject' | 'at' | 'seen'> & { text?: string }
  >,
  now: number,
  max = MAX_MAIL,
): Array<{ from: string; subject: string }> {
  const recent = messages
    .filter((m) => !m.seen)
    .filter((m) => Number.isFinite(m.at) && m.at <= now + 60_000 && now - m.at <= DAY_MS)
    .sort((a, b) => b.at - a.at);
  // Lo que huele a estafa sale primero y avisado, aunque venga de un «no-reply»:
  // solo se avisa, no se mueve ni se borra nada.
  const suspicious = recent.flatMap((m) => {
    const signals = phishingSignals({ from: m.from, subject: m.subject, text: m.text });
    return looksLikePhishing(signals)
      ? [{ from: senderName(m.from), subject: `⚠️ posible estafa (${signals[0]}): ${m.subject}` }]
      : [];
  });
  const normal = recent
    .filter(
      (m) =>
        !looksLikePhishing(phishingSignals({ from: m.from, subject: m.subject, text: m.text })),
    )
    .filter((m) => !BULK_FROM.test(m.from) && !BULK_SUBJECT.test(m.subject))
    .map((m) => ({ from: senderName(m.from), subject: m.subject }));
  return [...suspicious, ...normal].slice(0, max);
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
  const days = await fetchWeatherDays(cfg, 1, fetchFn, timeoutMs);
  const today = days[0];
  if (!today) return null;
  return `Tiempo${cfg.label ? ` en ${cfg.label}` : ''}: ${today.text}`;
}

export interface WeatherDay {
  /** Fecha local YYYY-MM-DD del sitio configurado. */
  date: string;
  /** «8–17 °C, despejado» o «8–17 °C, lluvia (60 %)». */
  text: string;
}

/**
 * Previsión de 1 a 7 días con Open-Meteo (el mismo servicio gratis y sin clave del
 * resumen diario). Los errores de red se propagan; días sin datos se omiten.
 */
export async function fetchWeatherDays(
  cfg: WeatherConfig,
  days: number,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 8_000,
): Promise<WeatherDay[]> {
  const n = Math.min(7, Math.max(1, Math.round(days) || 1));
  const url =
    'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${cfg.latitude}&longitude=${cfg.longitude}` +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
    `&timezone=auto&forecast_days=${n}`;
  const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`el servicio del tiempo ha respondido ${res.status}`);
  const body = (await res.json()) as {
    daily?: {
      time?: string[];
      weather_code?: number[];
      temperature_2m_max?: number[];
      temperature_2m_min?: number[];
      precipitation_probability_max?: Array<number | null>;
    };
  };
  const d = body.daily;
  const out: WeatherDay[] = [];
  for (let i = 0; i < n; i++) {
    const max = d?.temperature_2m_max?.[i];
    const min = d?.temperature_2m_min?.[i];
    if (typeof max !== 'number' || typeof min !== 'number') continue;
    const code = d?.weather_code?.[i];
    const parts = [`${Math.round(min)}–${Math.round(max)} °C`];
    const sky = typeof code === 'number' ? weatherCodeEs(code) : '';
    const rain = d?.precipitation_probability_max?.[i];
    const wet = sky === 'lluvia' || sky === 'llovizna' || sky === 'tormenta';
    if (typeof rain === 'number' && rain >= 30) {
      parts.push(
        wet
          ? `${sky} (${Math.round(rain)} %)`
          : `${sky ? `${sky}, ` : ''}${Math.round(rain)} % de lluvia`,
      );
    } else if (sky) parts.push(sky);
    out.push({ date: String(d?.time?.[i] ?? ''), text: parts.join(', ') });
  }
  return out;
}

function sameLocalDay(a: Date, b: Date): boolean {
  return localDay(a) === localDay(b);
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
  // Fin de hoy en la zona de Nico: el primer instante de mañana menos 1 ms.
  const w = wallClock(now);
  const end = zonedTime(w.year, w.month, w.day + 1) - 1;
  return items
    .filter((f) => f.status === 'pending' && Number.isFinite(f.dueAt) && f.dueAt <= end)
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
