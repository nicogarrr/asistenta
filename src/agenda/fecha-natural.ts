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
  String.raw`|(?:el\s+)?(?:proximo\s+)?(${DIAS.join('|')})(?:\s+que\s+viene)?` +
  String.raw`|(\d{4})-(\d{1,2})-(\d{1,2})` +
  String.raw`|(?:el\s+)?(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?` +
  String.raw`|(?:el\s+)?(?:dia\s+)?(\d{1,2})(?:\s+de\s+(${MESES.join('|')}|sept|ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)\.?)?(?:\s+de\s+(\d{4}))?)`;
const TIME = String.raw`(?:a\s+las?\s+(\d{1,2})(?:[:.](\d{2})|(?![:.]?\d))|(\d{1,2})[:.](\d{2}))(?:\s*h)?(?:\s+de\s+la\s+(manana|tarde|noche|madrugada))?(?:\s*([ap])\.?\s?m\.?(?![a-z]))?`;
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
  return (
    text
      // «a las doce del mediodía» y «al mediodía»: antes el primero dejaba «del mediodía» en el
      // título y el segundo no se entendía. Solo si no se dijo ya otra hora antes (entonces
      // «mediodía» es parte del título).
      .replace(/\ba\s+las\s+(?:12|doce)\s+del\s+mediodia\b/, 'a las 12:00')
      .replace(/\bal?\s+mediodia\b/, (w: string, at: number, all: string) =>
        /\ba\s+las?\s+\S/.test(all.slice(0, at)) ? w : 'a las 12:00',
      )
      // «mañana por la tarde a las 5 café»: la parte del día delante de la hora pasa detrás
      // («a las 5 de la tarde»). Antes no se entendía. «A la una» no (decisión pendiente).
      .replace(
        /\bpor\s+la\s+(manana|tarde|noche)\s*,?\s+(a\s+las\s+(?:(?:1\d|2[0-3]|[2-9])(?:[:.]\d{2})?|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)(?:\s+y\s+media|\s+y\s+cuarto|\s+menos\s+cuarto)?)\b(?!\s+de\s+la\b|[:.]\d)/,
        '$2 de la $1',
      )
      // «a las 9 en punto bus»: antes «en punto bus» era el título.
      .replace(
        /(\ba\s+las?\s+(?:\d{1,2}(?::\d{2})?|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce))\s+en\s+punto\b/,
        '$1',
      )
      .replace(
        /\ba\s+las?\s+(una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)\b/,
        // «a la una» es la hora de comer (13:00) salvo «de la madrugada/mañana/noche».
        (_w, word: string, at: number, all: string) =>
          word === 'una' &&
          !/^(?:\s+(?:y\s+media|y\s+cuarto|menos\s+cuarto))?\s+de\s+la\s+(?:madrugada|manana|noche)\b/.test(
            all.slice(at + _w.length),
          )
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
      )
  );
}

const LEAD = String.raw`^(\s*(?:(?:add|anadir|apunta(?:me)?)\s+)?)`;
/** «esta noche a las 10 cena» → «hoy a las 10 de la noche cena» (y «esta tarde», «esta mañana»). */
const ESTA = new RegExp(
  `${LEAD}esta\\s+(manana|tarde|noche)\\s*,?\\s*(a\\s+las?\\s+(?:\\d{1,2}(?:[:.]\\d{2})?|${Object.keys(PALABRAS).join('|')})(?:\\s+y\\s+media|\\s+y\\s+cuarto|\\s+menos\\s+cuarto)?)\\b(?!\\s+de\\s+la\\b|\\s+y\\s+(?:media|cuarto)|\\s+menos\\s+cuarto)`,
);
/** «el viernes 6 (de noviembre)», «el lunes 9/11»: el día de la semana delante del número. */
const DIA_Y_NUMERO = new RegExp(
  `${LEAD}(?:el\\s+)?(${DIAS.join('|')})\\s*,?\\s+(?=(?:dia\\s+)?\\d{1,2}(?!\\d)(?![:.]\\d))`,
);

/**
 * Formas de decir el día que se reescriben antes de leer: «esta noche a las 10» y «el
 * viernes 6». Devuelve el texto y, si se dijo, el día de la semana, que tiene que cuadrar
 * con la fecha (si no, se pregunta otra vez en vez de adivinar).
 */
function diaHablado(text: string): { text: string; weekday: number | null } {
  const esta = text.replace(
    ESTA,
    (_w, lead: string, part: string, time: string) => `${lead}hoy ${time} de la ${part}`,
  );
  const m = DIA_Y_NUMERO.exec(esta);
  if (!m) return { text: esta, weekday: null };
  return {
    text: `${m[1]}el ${esta.slice(m[0].length)}`,
    weekday: DIAS.indexOf(m[2] as string),
  };
}

const NUM_REL: Readonly<Record<string, number>> = {
  un: 1,
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
  quince: 15,
  veinte: 20,
  treinta: 30,
};
const RELATIVO = new RegExp(
  String.raw`^\s*(?:(?:add|anadir|apunta(?:me)?)\s+)?(?:en|dentro\s+de)\s+(?:(media\s+hora)|(\d{1,3}|${Object.keys(NUM_REL).join('|')})\s+(minutos?|mins?|horas?|dias?|semanas?)(\s+y\s+media)?)(?![a-z])[\s,:|.-]*`,
);

/**
 * «en 2 horas dentista», «dentro de media hora llamar a Ana», «dentro de 2 semanas a las 9
 * revisión», «en 3 días a las 10 ITV»: antes no se entendía y se volvía a preguntar.
 * Minutos y horas cuentan desde ahora; días y semanas necesitan la hora detrás. null si
 * el texto no empieza así (lo lee el formato normal).
 */
function relativo(
  original: string,
  now: Date,
  timeZone: string | undefined,
): { start: Date; title: string } | null | undefined {
  const r = RELATIVO.exec(fold(original));
  if (!r) return undefined;
  const rest = original.slice(r[0].length).trim();
  const unit = r[3] ?? '';
  const n = r[1] ? 0.5 : Number(NUM_REL[r[2] ?? ''] ?? r[2]);
  const half = r[4] ? 0.5 : 0;
  if (r[1] || unit.startsWith('min') || unit.startsWith('hora')) {
    // Una hora detrás («en 2 horas a las 9») no cuadra: se pregunta.
    if (!rest || /^a\s+las?\s+\d/i.test(fold(rest))) return null;
    const minutes = r[1] ? 30 : unit.startsWith('min') ? n + half : (n + half) * 60;
    if (!(minutes > 0)) return null;
    const at = Math.floor(now.getTime() / 60_000) * 60_000 + Math.round(minutes) * 60_000;
    return { start: new Date(at), title: rest };
  }
  if (half || !(n > 0)) return null;
  const today = wallClock(now, timeZone);
  const [y, mo, d] = addDays(
    today.year,
    today.month,
    today.day,
    unit.startsWith('semana') ? n * 7 : n,
  );
  const dated = parseFechaCalendario(`el ${d}/${mo}/${y} ${rest}`, now, timeZone);
  return dated;
}

export function parseFechaCalendario(
  text: string,
  now: Date = new Date(),
  timeZone?: string,
): { start: Date; title: string } | null {
  const original = text.normalize('NFC').trim();
  const rel = relativo(original, now, timeZone);
  if (rel !== undefined) return rel;
  const said = diaHablado(fold(original));
  const m = RE.exec(horaHablada(said.text));
  if (!m) return null;
  // El título es el final del texto: se toma del original con su misma longitud (la hora
  // hablada que se reescribió va antes y no cambia el título).
  const tail = (m[18] ?? '').length;
  const title = original.slice(original.length - tail).trim();
  if (!title) return null;
  // «mañana a las 21 30 cena», «a las 9 h 30»: los minutos quedaban en el título («30
  // cena») y el aviso a las 21:00 o a las 9:00. Si tras una hora sin minutos ni parte del
  // día el título empieza por dos cifras, se pregunta otra vez.
  if (m[12] && !m[13] && !m[16] && !m[17] && /^[0-5]\d(?!\S)/.test(title)) return null;
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
      // «el 10 de nov», «el 3 de sept.»: el mes abreviado, como se escribe en el móvil.
      mo = MESES.findIndex((name) => name.startsWith(m[10]?.slice(0, 3) ?? '')) + 1;
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
  if (said.weekday !== null && new Date(Date.UTC(y, mo - 1, d)).getUTCDay() !== said.weekday)
    return null;
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
  // «a las 8 pm», «9:30 p.m.», «12 am»: antes «pm» se ignoraba (8:00) y acababa en el título.
  if (m[17] === 'p' && h >= 1 && h < 12) h += 12;
  else if (m[17] === 'a' && h === 12) h = 0;
  if (h > 23 || mi > 59) return null;
  return { start: new Date(zonedTime(y, mo, d, h, mi, timeZone)), title };
}
