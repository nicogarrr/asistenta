/**
 * /previsto: lo que Asistenta va a hacer por ti, por orden de hora.
 *
 * Muse enseña «a complete audit trail of everything it has done and plans to do»
 * (https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/). Aquí lo hecho ya
 * se ve (registro de acciones, /recordatorios, /cron), pero lo que viene estaba repartido
 * en tres órdenes: recordatorios en /recordatorios, rutinas en /cron, el resumen de la
 * bandeja en /bandeja. Esto lo junta en una lista: cada vez que va a pasar algo en el rango,
 * de la más cercana a la más lejana (una rutina diaria sale los 7 días en /previsto semana;
 * la que suena varias veces el mismo día sale una vez ese día, con cuántas y hasta qué hora).
 *
 * - `/previsto` — las próximas 24 h. `/previsto hoy` — hasta medianoche.
 *   `/previsto semana` — 7 días.
 * - Solo lectura: no cambia nada. Las rutinas en pausa no salen (se cuentan al final).
 */

import { cadenciaDeRutina, fueraDeCadencia } from './cron/cadencia.js';
import { localDay } from './datecontext.js';
import type { Routine } from './db.js';
import { skipsHolidays } from './festivos-rutinas.js';
import { scheduleRunsAfter } from './routines.js';
import { fechaCortaEs, isOneShotReminder, isReminder, reminderText } from './tools/reminder.js';

export type PrevistoRango = 'dia' | 'hoy' | 'semana';

export interface PrevistoExtra {
  at: Date;
  text: string;
  /** Horario cron si se repite (el resumen de la bandeja, cada noche). */
  cada?: string;
}

/** Tope de ejecuciones que se miran por cosa (una vigilancia cada 5 min en una semana). */
const MAX_RUNS = 2100;
/** Más de estas veces el mismo día y se dicen en una línea («24 veces, hasta las 23:00»). */
const MAX_POR_DIA = 2;

/**
 * Las veces que suena una rutina después de la primera (que da el planificador), según su
 * cron y su cadencia («cada 2 días» se salta el día de en medio). Un recordatorio de una
 * vez suena una vez. «Excepto festivos»: solo se sabe la próxima, así que no se inventan
 * las demás.
 */
export function siguientesEjecuciones(r: Routine, first: Date, end: number): Date[] {
  if (!r.schedule || isOneShotReminder(r) || skipsHolidays(`${r.name} ${r.prompt ?? ''}`))
    return [];
  const cadencia = cadenciaDeRutina(r);
  const out: Date[] = [];
  let last = first.toISOString();
  for (const run of scheduleRunsAfter(r.schedule, first, MAX_RUNS)) {
    if (run.getTime() > end) break;
    if (cadencia && fueraDeCadencia(cadencia, run, last)) continue;
    out.push(run);
    last = run.toISOString();
  }
  return out;
}

function hhmm(d: Date): string {
  return fechaCortaEs(d).slice(-5);
}

/** Una fila por vez; si una misma cosa suena más de MAX_POR_DIA veces un día, una sola. */
function filasDe(runs: readonly Date[], icon: string, text: string): PrevistoFila[] {
  const porDia = new Map<string, Date[]>();
  for (const at of runs) {
    const day = localDay(at);
    const list = porDia.get(day);
    if (list) list.push(at);
    else porDia.set(day, [at]);
  }
  const filas: PrevistoFila[] = [];
  for (const list of porDia.values()) {
    const first = list[0] as Date;
    const lastRun = list[list.length - 1] as Date;
    if (list.length > MAX_POR_DIA)
      filas.push({
        at: first,
        icon,
        text: `${text} · ${list.length} veces, hasta las ${hhmm(lastRun)}`,
      });
    else for (const at of list) filas.push({ at, icon, text });
  }
  return filas;
}

export interface PrevistoFila {
  at: Date;
  icon: string;
  text: string;
}

export function previstoRango(args: string): PrevistoRango | null {
  const a = args
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (!a || /^(24 ?h|manana|dia)$/.test(a)) return 'dia';
  if (a === 'hoy') return 'hoy';
  if (/^(semana|7 ?d(ias)?)$/.test(a)) return 'semana';
  return null;
}

function hasta(rango: PrevistoRango, now: Date): number {
  if (rango === 'semana') return now.getTime() + 7 * 86_400_000;
  if (rango === 'dia') return now.getTime() + 86_400_000;
  // Hoy: hasta que cambie el día local (sin depender de la zona del proceso).
  const today = localDay(now);
  let t = now.getTime();
  for (let step = 3_600_000; step >= 60_000; step /= 60) {
    while (localDay(new Date(t + step)) === today) t += step;
  }
  return t + 60_000;
}

/**
 * El resumen de la bandeja en /previsto. Solo sale si hay algo (runDigestIfDue: «empty» no
 * manda nada), así que se dice: el de esta noche con cuántas cosas lleva, o «solo si le
 * mandas algo»; los siguientes, «si hay algo». Si hoy ya salió (/bandeja resumen a mano
 * también cuenta), esta noche no vuelve a salir y no se enseña.
 */
export function extrasBandeja(
  cada: string,
  now: Date,
  o: { pendientes: number; yaSalioHoy: boolean },
): PrevistoExtra[] {
  const runs = scheduleRunsAfter(cada, now, 2);
  const today = localDay(now);
  const first = runs[0];
  if (!first) return [];
  const out: PrevistoExtra[] = [];
  let later = first;
  if (localDay(first) === today) {
    if (!o.yaSalioHoy)
      out.push({
        at: first,
        text: o.pendientes
          ? `📥 resumen de la bandeja (${o.pendientes === 1 ? '1 cosa' : `${o.pendientes} cosas`})`
          : '📥 resumen de la bandeja (solo si le mandas algo)',
      });
    const next = runs[1];
    if (!next) return out;
    later = next;
  }
  out.push({ at: later, text: '📥 resumen de la bandeja (si hay algo)', cada });
  return out;
}

/**
 * Lo previsto, ordenado. `nextOf` es la próxima vez según el planificador; `masTarde`, las
 * siguientes dentro del rango (por defecto, `siguientesEjecuciones`).
 */
export function previstoFilas(
  routines: readonly Routine[],
  nextOf: (r: Routine) => Date | null,
  rango: PrevistoRango,
  now: Date,
  extras: readonly PrevistoExtra[] = [],
  masTarde: (r: Routine, first: Date, end: number) => Date[] = siguientesEjecuciones,
): { filas: PrevistoFila[]; pausadas: number } {
  const end = hasta(rango, now);
  const filas: PrevistoFila[] = [];
  let pausadas = 0;
  for (const r of routines) {
    if (r.kind !== 'schedule' || !r.schedule) continue;
    if (!r.enabled) {
      pausadas++;
      continue;
    }
    const at = nextOf(r);
    if (!at || Number.isNaN(at.getTime()) || at.getTime() < now.getTime() - 60_000) continue;
    if (at.getTime() > end) continue;
    const runs = [
      at,
      ...masTarde(r, at, end).filter((d) => d.getTime() > at.getTime() && d.getTime() <= end),
    ];
    if (isReminder(r)) filas.push(...filasDe(runs, '⏰', reminderText(r)));
    else filas.push(...filasDe(runs, '🔁', `rutina «${r.name}»`));
  }
  for (const e of extras) {
    if (e.at.getTime() < now.getTime() - 60_000 || e.at.getTime() > end) continue;
    const runs = [e.at];
    if (e.cada)
      for (const d of scheduleRunsAfter(e.cada, e.at, MAX_RUNS)) {
        if (d.getTime() > end) break;
        runs.push(d);
      }
    filas.push(...filasDe(runs, '', e.text));
  }
  filas.sort((a, b) => a.at.getTime() - b.at.getTime() || a.text.localeCompare(b.text));
  return { filas, pausadas };
}

const TITULO: Record<PrevistoRango, string> = {
  dia: 'las próximas 24 h',
  hoy: 'lo que queda de hoy',
  semana: 'los próximos 7 días',
};
const MAX_FILAS = 40;

export function previstoTexto(
  out: { filas: PrevistoFila[]; pausadas: number },
  rango: PrevistoRango,
  now: Date,
): string {
  const pausa = out.pausadas
    ? out.pausadas === 1
      ? '\n⏸️ 1 rutina en pausa no sale (/cron para verla).'
      : `\n⏸️ ${out.pausadas} rutinas en pausa no salen (/cron para verlas).`
    : '';
  if (!out.filas.length)
    return `🗓️ Nada previsto para ${TITULO[rango]}.${rango === 'semana' ? '' : ' /previsto semana para ver más lejos.'}${pausa}`;
  const today = localDay(now);
  const lines: string[] = [];
  let lastDay = '';
  for (const f of out.filas.slice(0, MAX_FILAS)) {
    const day = localDay(f.at);
    const stamp = fechaCortaEs(f.at); // «mié 11/11 21:30»
    const hm = stamp.slice(-5);
    if (rango === 'semana' && day !== lastDay) {
      lines.push(day === today ? 'Hoy' : stamp.slice(0, -6));
      lastDay = day;
    }
    const when = rango === 'semana' || day === today ? hm : `mañana ${hm}`;
    lines.push(`• ${when} ${f.icon ? `${f.icon} ` : ''}${f.text}`);
  }
  const more = out.filas.length > MAX_FILAS ? `\n…y ${out.filas.length - MAX_FILAS} más.` : '';
  return `🗓️ Lo que haré por ti en ${TITULO[rango]} (${out.filas.length}):\n${lines.join('\n')}${more}${pausa}\n\nPara cambiar algo: /recordatorios, /cron o /bandeja.`;
}
