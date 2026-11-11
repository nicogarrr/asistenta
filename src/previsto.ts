/**
 * /previsto: lo que Asistenta va a hacer por ti, por orden de hora.
 *
 * Muse enseña «a complete audit trail of everything it has done and plans to do»
 * (https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/). Aquí lo hecho ya
 * se ve (registro de acciones, /recordatorios, /cron), pero lo que viene estaba repartido
 * en tres órdenes: recordatorios en /recordatorios, rutinas en /cron, el resumen de la
 * bandeja en /bandeja. Esto lo junta en una lista: la próxima vez de cada cosa, de la más
 * cercana a la más lejana.
 *
 * - `/previsto` — las próximas 24 h. `/previsto hoy` — hasta medianoche.
 *   `/previsto semana` — 7 días.
 * - Solo lectura: no cambia nada. Las rutinas en pausa no salen (se cuentan al final).
 */

import { localDay } from './datecontext.js';
import type { Routine } from './db.js';
import { fechaCortaEs, isReminder, reminderText } from './tools/reminder.js';

export type PrevistoRango = 'dia' | 'hoy' | 'semana';

export interface PrevistoExtra {
  at: Date;
  text: string;
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

/** Lo previsto, ordenado. `nextOf` es la próxima vez según el planificador. */
export function previstoFilas(
  routines: readonly Routine[],
  nextOf: (r: Routine) => Date | null,
  rango: PrevistoRango,
  now: Date,
  extras: readonly PrevistoExtra[] = [],
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
    filas.push(
      isReminder(r)
        ? { at, icon: '⏰', text: reminderText(r) }
        : { at, icon: '🔁', text: `rutina «${r.name}»` },
    );
  }
  for (const e of extras) {
    if (e.at.getTime() >= now.getTime() - 60_000 && e.at.getTime() <= end)
      filas.push({ at: e.at, icon: '', text: e.text });
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
