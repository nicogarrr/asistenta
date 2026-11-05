/**
 * Las fechas que el dueño ha contado («mi cumpleaños es el 3 de mayo», «el cumple de mi
 * madre es el 14 de febrero», «mi aniversario con Ana es el 20/6») vistas como lo haría un
 * buen asistente: el día antes y el mismo día se acuerda él, sin que nadie se lo pida.
 *
 * Solo lee lo ya apuntado (perfil y memoria); no guarda nada. Antes esas fechas estaban
 * en la memoria pero nada miraba el calendario: el resumen de la mañana y el modelo no
 * sabían que mañana era el cumpleaños de su madre.
 */
import { wallClock } from '../datecontext.js';
import { foldAccents } from '../text.js';

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];
const WEEKDAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

/** Qué clase de fecha es: sin una de estas palabras, una fecha suelta no es un aniversario. */
const KIND = /\b(?:cumple(?:anos|años)?|cumpleanos|aniversario|santo|onomastica)\b/;

export interface KnownDate {
  /** De qué es, en segunda persona: «tu cumpleaños», «cumple de tu madre». */
  label: string;
  month: number;
  day: number;
}

export interface UpcomingDate {
  label: string;
  /** 0 = hoy, 1 = mañana… */
  inDays: number;
  /** «hoy», «mañana (vie 06/11)», «sáb 08/11 (en 3 días)». */
  when: string;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** «3 de mayo», «el 14/2», «20-06»: mes y día; null si no hay una fecha clara. */
function monthDay(folded: string): { month: number; day: number; match: string } | null {
  const named = new RegExp(
    `\\b(\\d{1,2})\\s+de\\s+(${MONTHS.join('|').replace('septiembre', 'sept?iembre')})\\b`,
  ).exec(folded);
  if (named?.[1] && named[2]) {
    const month = MONTHS.indexOf(named[2].replace(/^setiembre$/, 'septiembre')) + 1;
    const day = Number(named[1]);
    if (month >= 1 && validDay(month, day)) return { month, day, match: named[0] };
  }
  const numeric = /\b(\d{1,2})[/-](\d{1,2})\b(?![/-]\d)/.exec(folded);
  if (numeric?.[1] && numeric[2]) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]);
    if (month >= 1 && month <= 12 && validDay(month, day)) return { month, day, match: numeric[0] };
  }
  return null;
}

function validDay(month: number, day: number): boolean {
  const max = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return day >= 1 && day <= max;
}

/** «Mi cumpleaños es el 3 de mayo» → «tu cumpleaños»; «El cumple de mi madre…» → «cumple de tu madre». */
function labelOf(text: string, dateMatch: string): string | null {
  const t = foldAccents(text)
    .replace(/^\[(?:auto|dicho)\]\s*/i, '')
    .replace(/[.!]+$/, '')
    .trim();
  const cut = t.indexOf(dateMatch);
  let head = (cut >= 0 ? t.slice(0, cut) : t)
    .replace(/\s+(?:es|son|cae|caen|sera|fue)?\s*(?:el|los)?\s*(?:dia\s*)?$/, '')
    .replace(/\s+(?:es|son|cae|caen|sera)$/, '')
    .trim();
  // «Mi madre cumple años el…» / «mi madre cumple el…» → «cumple de mi madre».
  const turns = /^(.+?)\s+cumple(?:\s+anos)?$/.exec(head);
  if (turns?.[1]) head = `cumple de ${turns[1]}`;
  if (!head || head.length > 80 || !KIND.test(head)) return null;
  return head
    .replace(/^(?:el|la)\s+/, '')
    .replace(/\bmis\b/g, 'tus')
    .replace(/\bmi\b/g, 'tu')
    .replace(/\bcumpleanos\b/g, 'cumpleaños')
    .replace(/\bonomastica\b/g, 'onomástica')
    .trim();
}

/** Las fechas que hay en lo apuntado; una por entrada, sin repetir la misma. */
export function knownDates(entries: readonly string[]): KnownDate[] {
  const out: KnownDate[] = [];
  const seen = new Set<string>();
  for (const raw of entries) {
    const text = raw.replace(/\s+/g, ' ').trim();
    if (!text || text.length > 200) continue;
    const folded = foldAccents(text.toLowerCase());
    if (!KIND.test(folded)) continue;
    const md = monthDay(folded);
    if (!md) continue;
    const label = labelOf(text.toLowerCase(), md.match);
    if (!label) continue;
    const key = `${label}|${md.month}|${md.day}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, month: md.month, day: md.day });
  }
  return out;
}

/**
 * Las que caen de hoy a dentro de `days` días (en la zona del dueño), la más cercana
 * primero. Un 29 de febrero, en año no bisiesto, cae el 28.
 */
export function upcomingDates(
  entries: readonly string[],
  now: Date,
  days = 7,
  timeZone?: string,
): UpcomingDate[] {
  const w = wallClock(now, timeZone);
  const today = Date.UTC(w.year, w.month - 1, w.day, 12);
  const out: UpcomingDate[] = [];
  for (const d of knownDates(entries)) {
    for (const year of [w.year, w.year + 1]) {
      const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
      const day = d.month === 2 && d.day === 29 && !leap ? 28 : d.day;
      const at = Date.UTC(year, d.month - 1, day, 12);
      const inDays = Math.round((at - today) / 86_400_000);
      if (inDays < 0) continue;
      if (inDays <= days) {
        const date = new Date(at);
        const short = `${WEEKDAYS[date.getUTCDay()]} ${pad(day)}/${pad(d.month)}`;
        const when =
          inDays === 0
            ? 'hoy'
            : inDays === 1
              ? `mañana (${short})`
              : `${short} (en ${inDays} días)`;
        out.push({ label: d.label, inDays, when });
      }
      break;
    }
  }
  return out.sort((a, b) => a.inDays - b.inDays);
}

/** Línea para el resumen de la mañana: «Hoy: cumple de tu madre». */
export function upcomingDateLine(d: UpcomingDate): string {
  const when = d.when.charAt(0).toUpperCase() + d.when.slice(1);
  return `${when}: ${d.label}`;
}

/**
 * Nota para el modelo con lo que cae en los próximos días; '' si no hay nada (no cuesta
 * nada cuando no toca).
 */
export function upcomingDatesNote(upcoming: readonly UpcomingDate[]): string {
  if (upcoming.length === 0) return '';
  const lines = upcoming
    .slice(0, 5)
    .map((d) => `- ${d.when}: ${d.label.replace(/\btu\b/g, 'su').replace(/\btus\b/g, 'sus')}`);
  return `<fechas>\nFechas que el dueño te contó y caen pronto (díselo una vez, de forma natural, si viene a cuento: al saludar, en el resumen de la mañana o si habla de esa persona):\n${lines.join('\n')}\n</fechas>`;
}
