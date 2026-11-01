/**
 * /calendario dicho normal: «mañana a las 18:00 dentista», «el 2 de noviembre a las
 * 10 revisión del coche», «el viernes a las 9 de la noche cena». Nico (1 nov): «como
 * estamos hablando nosotros», sin «2026-11-02 18:00 | Dentista». La fecha y la hora
 * son de pared en PA_TIMEZONE; lo que no encaja devuelve null y se pregunta otra vez.
 */
import { wallClock, zonedTime } from '../datecontext.js';

const MESES = [
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
const DIAS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

const DAY =
  '(hoy|pasado manana|manana' +
  String.raw`|(?:el\s+)?(${DIAS.join('|')})(?:\s+que\s+viene)?` +
  String.raw`|(\d{4})-(\d{1,2})-(\d{1,2})` +
  String.raw`|(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?` +
  String.raw`|(?:el\s+)?(?:dia\s+)?(\d{1,2})(?:\s+de\s+(${MESES.join('|')}))?(?:\s+de\s+(\d{4}))?)`;
const TIME = String.raw`(?:a\s+las?\s+(\d{1,2})(?:[:.](\d{2})|(?![:.]?\d))|(\d{1,2})[:.](\d{2}))(?:\s*h)?(?:\s+de\s+la\s+(manana|tarde|noche|madrugada))?`;
const RE = new RegExp(
  String.raw`^\s*(?:(?:add|anadir|apunta(?:me)?)\s+)?${DAY}\s*,?\s*${TIME}[\s,:|.-]+(\S.*)$`,
);

function fold(text: string): string {
  // NFC primero: así cada letra con tilde es un carácter y los índices cuadran.
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[áàä]/g, 'a')
    .replace(/[éèë]/g, 'e')
    .replace(/[íìï]/g, 'i')
    .replace(/[óòö]/g, 'o')
    .replace(/[úùü]/g, 'u')
    .replace(/ñ/g, 'n');
}

function exists(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function addDays(y: number, m: number, d: number, n: number): [number, number, number] {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
}

export function parseFechaCalendario(
  text: string,
  now: Date = new Date(),
  timeZone?: string,
): { start: Date; title: string } | null {
  const original = text.normalize('NFC').trim();
  const m = RE.exec(fold(original));
  if (!m) return null;
  const titleStart = m.index + m[0].length - (m[17] ?? '').length;
  const title = original.slice(titleStart).trim();
  if (!title) return null;
  const today = wallClock(now, timeZone);
  let y = today.year;
  let mo = today.month;
  let d = today.day;
  const word = m[1] ?? '';
  if (word === 'manana') [y, mo, d] = addDays(y, mo, d, 1);
  else if (word === 'pasado manana') [y, mo, d] = addDays(y, mo, d, 2);
  else if (m[2]) {
    let n = (DIAS.indexOf(m[2]) - today.weekday + 7) % 7;
    if (n === 0) n = 7;
    [y, mo, d] = addDays(y, mo, d, n);
  } else if (m[3]) {
    y = Number(m[3]);
    mo = Number(m[4]);
    d = Number(m[5]);
  } else if (m[6]) {
    d = Number(m[6]);
    mo = Number(m[7]);
    if (m[8]) y = Number(m[8].length === 2 ? `20${m[8]}` : m[8]);
    else if (mo < today.month || (mo === today.month && d < today.day)) y += 1;
  } else if (m[9]) {
    d = Number(m[9]);
    if (m[10]) {
      mo = MESES.indexOf(m[10]) + 1;
      if (m[11]) y = Number(m[11]);
      else if (mo < today.month || (mo === today.month && d < today.day)) y += 1;
    } else if (d < today.day) {
      [y, mo] = mo === 12 ? [y + 1, 1] : [y, mo + 1];
    }
  }
  if (!exists(y, mo, d)) return null;
  let h = Number(m[12] ?? m[14]);
  const mi = Number(m[13] ?? m[15] ?? 0);
  const part = m[16];
  if ((part === 'tarde' || part === 'noche') && h < 12) h += 12;
  // «a las 12 de la noche» es la medianoche al acabar ese día y «a las 12 de la
  // madrugada» las 00:00 de ese día, como lo lee la agenda del correo; antes las dos
  // quedaban a mediodía.
  if (h === 12 && part === 'noche') [y, mo, d] = addDays(y, mo, d, 1);
  if (h === 12 && (part === 'noche' || part === 'madrugada')) h = 0;
  if (h > 23 || mi > 59) return null;
  return { start: new Date(zonedTime(y, mo, d, h, mi, timeZone)), title };
}
