/**
 * Convierte el estado de openGym en texto para Telegram. Funciones puras, sin red.
 *
 * Regla: nunca una cifra que no esté en el documento. Si falta un dato, se dice.
 * Los ejercicios se nombran con el catálogo de openGym y, si es un ejercicio propio,
 * con `customEx` del propio estado.
 */

import type { GymState } from './client.js';
import { EXERCISES } from './exercises.js';

const DEFAULT_TZ = 'Europe/Madrid';

interface Workout {
  id?: string;
  d?: string;
  start?: number;
  end?: number;
  routineId?: string;
  name?: string;
  bw?: number;
  vol?: number;
  prs?: string[];
  entries?: {
    id?: string;
    topW?: number | null;
    sets?: { w?: number; r?: number; done?: boolean }[];
  }[];
}

interface Routine {
  id?: string;
  name?: string;
  ex?: { id?: string }[];
}

function arr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as T[]) : [];
}

function unitOf(s: GymState): string {
  return s.unit === 'lb' ? 'lb' : 'kg';
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ',');
}

export function exerciseName(id: string, s: GymState): string {
  const custom = arr<{ id?: string; n?: string }>(s.customEx).find((c) => c.id === id);
  if (custom?.n) return custom.n;
  return EXERCISES[id]?.[0] ?? `ejercicio ${id}`;
}

function exerciseBodyPart(id: string, s: GymState): string | null {
  const custom = arr<{ id?: string; bp?: string }>(s.customEx).find((c) => c.id === id);
  return custom?.bp ?? EXERCISES[id]?.[1] ?? null;
}

function tzOf(s: GymState): string {
  const tz = (s.reminder as { tz?: unknown } | undefined)?.tz;
  if (typeof tz === 'string') {
    try {
      new Intl.DateTimeFormat('es', { timeZone: tz });
      return tz;
    } catch {
      /* zona inválida: se usa la de Madrid */
    }
  }
  return DEFAULT_TZ;
}

/** Fecha local "YYYY-MM-DD" en la zona dada. */
export function localDate(now: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Día de la semana de una fecha ISO: 0 = domingo ... 6, como el `week` de openGym. */
export function weekday(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y as number, (m as number) - 1, d as number)).getUTCDay();
}

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y as number, (m as number) - 1, (d as number) + n))
    .toISOString()
    .slice(0, 10);
}

const DAYS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** Rutina planeada para una fecha: `dayPlan` manda sobre `week`. null = nada planeado; 'rest' = descanso. */
function plannedFor(s: GymState, iso: string): string | null {
  const dayPlan = (s.dayPlan ?? {}) as Record<string, unknown>;
  const week = (s.week ?? {}) as Record<string, unknown>;
  const v = dayPlan[iso] ?? week[String(weekday(iso))];
  return typeof v === 'string' && v ? v : null;
}

function routineById(s: GymState, id: string): Routine | undefined {
  return arr<Routine>(s.routines).find((r) => r.id === id);
}

export function todayText(s: GymState, now: Date): string {
  const tz = tzOf(s);
  const today = localDate(now, tz);
  const plan = plannedFor(s, today);
  const done = arr<Workout>(s.workouts).filter((w) => w.d === today);
  const head = `Hoy, ${DAYS_ES[weekday(today)]} ${today}:`;
  const lines: string[] = [];
  if (!plan) {
    lines.push(`${head} no tienes nada planeado en openGym.`);
  } else if (plan === 'rest') {
    lines.push(`${head} día de descanso.`);
  } else {
    const r = routineById(s, plan);
    if (!r) {
      lines.push(
        `${head} hay una rutina planeada (${plan}) pero no la encuentro entre tus rutinas.`,
      );
    } else {
      lines.push(`${head} toca ${r.name ?? plan}.`);
      const names = arr<{ id?: string }>(r.ex)
        .map((e) => (e.id ? exerciseName(e.id, s) : null))
        .filter((n): n is string => !!n);
      if (names.length) lines.push(names.map((n) => `- ${n}`).join('\n'));
    }
  }
  if (done.length) {
    lines.push(
      `Ya has registrado ${done.length === 1 ? 'un entreno' : `${done.length} entrenos`} hoy.`,
    );
  } else if (plan && plan !== 'rest') {
    lines.push('Todavía no has registrado ningún entreno hoy.');
  }
  return lines.join('\n');
}

function bestSet(
  sets: { w?: number; r?: number; done?: boolean }[] | undefined,
): { w: number; r: number } | null {
  let best: { w: number; r: number } | null = null;
  for (const st of sets ?? []) {
    if (st.done === false) continue;
    const w = num(st.w);
    const r = num(st.r);
    if (w === null || r === null) continue;
    if (!best || w > best.w || (w === best.w && r > best.r)) best = { w, r };
  }
  return best;
}

function sortedWorkouts(s: GymState): Workout[] {
  return arr<Workout>(s.workouts)
    .filter((w) => typeof w.d === 'string')
    .sort((a, b) =>
      `${a.d}${String(a.start ?? 0).padStart(15, '0')}`.localeCompare(
        `${b.d}${String(b.start ?? 0).padStart(15, '0')}`,
      ),
    );
}

export function lastWorkoutText(s: GymState): string {
  const w = sortedWorkouts(s).at(-1);
  if (!w) return 'No hay ningún entreno registrado en openGym.';
  const unit = unitOf(s);
  const lines = [`Último entreno: ${w.name ?? 'sin nombre'} (${w.d}).`];
  const start = num(w.start);
  const end = num(w.end);
  if (start !== null && end !== null && end > start)
    lines.push(`Duración: ${Math.round((end - start) / 60_000)} min.`);
  const vol = num(w.vol);
  if (vol !== null) lines.push(`Volumen: ${fmt(Math.round(vol))} ${unit}.`);
  for (const e of w.entries ?? []) {
    if (!e.id) continue;
    const b = bestSet(e.sets);
    lines.push(
      `- ${exerciseName(e.id, s)}${b ? `: mejor serie ${fmt(b.w)} ${unit} x ${fmt(b.r)}` : ''}`,
    );
  }
  if (w.prs?.length) lines.push(`Récords: ${w.prs.map((id) => exerciseName(id, s)).join(', ')}.`);
  return lines.join('\n');
}

interface Weigh {
  d: string;
  w: number;
}

function weights(s: GymState): Weigh[] {
  const direct = arr<{ d?: string; w?: number }>(s.bodyweight)
    .filter((b) => typeof b.d === 'string' && num(b.w) !== null)
    .map((b) => ({ d: b.d as string, w: b.w as number }));
  const rows = direct.length
    ? direct
    : arr<Workout>(s.workouts)
        .filter((w) => typeof w.d === 'string' && num(w.bw) !== null)
        .map((w) => ({ d: w.d as string, w: w.bw as number }));
  return rows.sort((a, b) => a.d.localeCompare(b.d));
}

export function weightText(s: GymState, now: Date): string {
  const rows = weights(s);
  const last = rows.at(-1);
  if (!last) return 'No hay ningún peso corporal registrado en openGym.';
  const unit = unitOf(s);
  const today = localDate(now, tzOf(s));
  const lines = [`Último peso: ${fmt(last.w)} ${unit} (${last.d}).`];
  const from = addDays(today, -30);
  const ref = rows.find((r) => r.d >= from && r.d < last.d);
  if (ref) {
    const diff = Math.round((last.w - ref.w) * 10) / 10;
    lines.push(
      `Desde ${ref.d} (${fmt(ref.w)} ${unit}): ${diff > 0 ? '+' : ''}${fmt(diff)} ${unit}.`,
    );
  } else {
    lines.push('No tengo otro peso en los últimos 30 días para comparar.');
  }
  return lines.join('\n');
}

const MAIN_PARTS: [string, string][] = [
  ['chest', 'pecho'],
  ['back', 'espalda'],
  ['shoulders', 'hombros'],
  ['upper arms', 'brazos'],
  ['upper legs', 'piernas'],
  ['lower legs', 'gemelos'],
  ['waist', 'core'],
];

/** Resumen de la semana lunes-domingo que contiene `now`. */
export function weeklyGymText(s: GymState, now: Date): string {
  const tz = tzOf(s);
  const today = localDate(now, tz);
  const dow = weekday(today);
  const monday = addDays(today, -((dow + 6) % 7));
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const sunday = days[6] as string;
  const planned = days.filter((d) => {
    const p = plannedFor(s, d);
    return p && p !== 'rest';
  }).length;
  const week = arr<Workout>(s.workouts).filter(
    (w) => typeof w.d === 'string' && w.d >= monday && w.d <= sunday,
  );
  const doneDays = new Set(week.map((w) => w.d)).size;
  const unit = unitOf(s);
  const lines = [`openGym, semana del ${monday} al ${sunday}:`];
  lines.push(
    planned
      ? `- Entrenos: ${doneDays} hechos de ${planned} planeados.`
      : `- Entrenos: ${doneDays} hechos (no hay plan semanal en openGym).`,
  );

  const prIds = new Set<string>();
  for (const w of week) for (const id of w.prs ?? []) prIds.add(id);
  lines.push(
    prIds.size
      ? `- Récords personales: ${prIds.size} (${[...prIds].map((id) => exerciseName(id, s)).join(', ')}).`
      : '- Récords personales: ninguno esta semana.',
  );

  const rows = weights(s);
  const last = rows.at(-1);
  if (last) {
    const before = [...rows].reverse().find((r) => r.d < monday);
    const diff = before ? Math.round((last.w - before.w) * 10) / 10 : null;
    lines.push(
      `- Peso: ${fmt(last.w)} ${unit} (${last.d})${diff !== null && before ? `, ${diff > 0 ? '+' : ''}${fmt(diff)} ${unit} respecto a ${before.d}` : ''}.`,
    );
  } else {
    lines.push('- Peso: sin registros.');
  }

  if (week.length) {
    const worked = new Set<string>();
    for (const w of week) {
      for (const e of w.entries ?? []) {
        if (!e.id || !(e.sets ?? []).some((st) => st.done !== false)) continue;
        const bp = exerciseBodyPart(e.id, s);
        if (bp) worked.add(bp);
      }
    }
    const missing = MAIN_PARTS.filter(([bp]) => !worked.has(bp)).map(([, es]) => es);
    lines.push(
      missing.length
        ? `- Sin trabajar esta semana: ${missing.join(', ')} (según los ejercicios que has registrado).`
        : '- Has trabajado todos los grupos principales.',
    );
  }
  return lines.join('\n');
}
