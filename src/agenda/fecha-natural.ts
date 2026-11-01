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
  String.raw`|(?:el\s+)?(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?` +
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

const PALABRAS: Readonly<Record<string, number>> = {
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
};

/**
 * La hora como se dice: «a las ocho», «a la una», «a las 9 y media», «a las 10 y cuarto»,
 * «a las 6 menos cuarto», «a mediodía». Se reescribe como «a las 9:30» antes de leer.
 * Antes «a las 9 y media médico» quedaba a las 09:00 con el título «y media médico», y
 * lo demás no se entendía. Solo la primera hora del texto (la del aviso, no el título).
 */
function horaHablada(text: string): string {
  return text
    .replace(/\ba\s+mediodia\b/, 'a las 12:00')
    .replace(
      /\ba\s+las?\s+(una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)\b/,
      // «a la una» es la hora de comer (13:00) salvo «de la madrugada/mañana/noche».
      (_w, word: string, at: number, all: string) =>
        word === 'una' &&
        !/^\s+de\s+la\s+(?:madrugada|manana|noche)\b/.test(all.slice(at + _w.length))
          ? 'a las 13'
          : `a las ${PALABRAS[word]}`,
    )
    .replace(
      /\ba\s+las?\s+(\d{1,2})\s+(y\s+media|y\s+cuarto|menos\s+cuarto)\b/,
      (whole, h: string, how: string) => {
        const hour = Number(h);
        if (how.startsWith('y') && hour <= 23) {
          return `a las ${hour}:${how.endsWith('media') ? '30' : '15'}`;
        }
        if (how.startsWith('menos') && hour >= 1 && hour <= 24) return `a las ${hour - 1}:45`;
        return whole;
      },
    );
}

export function parseFechaCalendario(
  text: string,
  now: Date = new Date(),
  timeZone?: string,
): { start: Date; title: string } | null {
  const original = text.normalize('NFC').trim();
  const m = RE.exec(horaHablada(fold(original)));
  if (!m) return null;
  // El título es el final del texto: se toma del original con su misma longitud (la hora
  // hablada que se reescribió va antes y no cambia el título).
  const tail = (m[17] ?? '').length;
  const title = original.slice(original.length - tail).trim();
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
  // «el 31» en un mes de 30 días: el próximo mes que lo tenga, no volver a preguntar.
  if (m[9] && !m[10]) {
    for (let i = 0; i < 12 && !exists(y, mo, d); i++)
      [y, mo] = mo === 12 ? [y + 1, 1] : [y, mo + 1];
  }
  if (!exists(y, mo, d)) return null;
  let h = Number(m[12] ?? m[14]);
  const mi = Number(m[13] ?? m[15] ?? 0);
  const part = m[16];
  // «a la una de la noche» (hasta las 4) es de madrugada, en la noche de ese día, como lo
  // lee la agenda del correo; antes quedaba a las 13:00.
  if (part === 'noche' && h >= 1 && h <= 4) [y, mo, d] = addDays(y, mo, d, 1);
  else if ((part === 'tarde' || part === 'noche') && h < 12) h += 12;
  // «a las 12 de la noche» es la medianoche al acabar ese día y «a las 12 de la
  // madrugada» las 00:00 de ese día, como lo lee la agenda del correo; antes las dos
  // quedaban a mediodía.
  if (h === 12 && part === 'noche') [y, mo, d] = addDays(y, mo, d, 1);
  if (h === 12 && (part === 'noche' || part === 'madrugada')) h = 0;
  if (h > 23 || mi > 59) return null;
  return { start: new Date(zonedTime(y, mo, d, h, mi, timeZone)), title };
}
