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

/** Minutos dichos con palabras tras «y»/«menos» («a las 10 y diez»). */
const MINUTOS: Readonly<Record<string, number>> = {
  cinco: 5,
  diez: 10,
  veinte: 20,
  veinticinco: 25,
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
      // «mañana sobre las 9 dentista», «hacia las 18», «a eso de las 10»: la hora aproximada
      // no se entendía y /calendario volvía a preguntar. Es «a las 9».
      .replace(
        /\b(?:sobre|hacia|a\s+eso\s+de|alrededor\s+de)\s+(las?\s+)(?=\d|(?:una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)\b)/,
        'a $1',
      )
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
      // «a las 9 h 15», «a las 9h15»: antes los minutos quedaban en el título y se volvía a
      // preguntar.
      .replace(/\b(a\s+las?\s+\d{1,2})\s*h\s*([0-5]\d)\b/, '$1:$2')
      // «a las 9 y 15 médico», «a las 10 y diez», «a las 6 menos 10»: antes quedaba a las 9:00
      // en punto con el título «y 15 médico». «y 10 minutos» también (sin dejar «minutos»).
      .replace(
        /\ba\s+las?\s+(\d{1,2})\s+(y|menos)\s+(\d{1,2}|cinco|diez|veinte|veinticinco)(?:\s+min(?:utos?)?)?\b(?![:.]\d)(?!\s+(?:personas?|euros?|horas?|dias?)\b)/,
        (whole, h: string, how: string, n: string) => {
          const hour = Number(h);
          const min = MINUTOS[n] ?? Number(n);
          if (!(min >= 1 && min <= 59) || hour > 23) return whole;
          if (how === 'y') return `a las ${hour}:${String(min).padStart(2, '0')}`;
          if (hour < 1 || min > 30) return whole;
          return `a las ${hour - 1}:${String(60 - min).padStart(2, '0')}`;
        },
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

const LEAD_RE = new RegExp(LEAD);
const FECHA_INICIO = new RegExp(
  `^(?:hoy|manana|pasado|el|este|esta|en|dentro|${DIAS.join('|')})(?![a-z])`,
);
const TITULO_COLGADO = /(?:^|\s)(?:a|al|las?|el|los|de|del|y|para|en|manana|hoy)$/;

/**
 * El título delante: «dentista mañana a las 9», «cena con Ana el viernes a las 21:30»,
 * «comida mañana a mediodía», «llamar a Ana en 2 horas». Antes solo se entendía con la
 * fecha delante y se volvía a preguntar. Se prueba a mover el título detrás de la fecha
 * (del corte más a la izquierda al más a la derecha) y vale solo si lo que queda detrás
 * de la fecha es exactamente ese título.
 */
function tituloDelante(
  original: string,
  now: Date,
  timeZone: string | undefined,
): { start: Date; title: string } | null {
  const lead = (LEAD_RE.exec(fold(original))?.[1] ?? '').length;
  const head = original.slice(0, lead);
  const body = original.slice(lead);
  const cuts = [...body.matchAll(/\s+(?=\S)/g)];
  for (const c of cuts) {
    const at = (c.index ?? 0) + c[0].length;
    const title = body
      .slice(0, c.index)
      .replace(/[\s,;:-]+$/, '')
      .trim();
    const fecha = body.slice(at).replace(/[\s.!]+$/, '');
    if (!title || !fecha) continue;
    // La fecha empieza por un día («mañana», «el viernes», «el 12/11», «en 2 horas») y el
    // título no acaba colgando («mañana a las» + «18:00» no es un título).
    if (!FECHA_INICIO.test(fold(fecha)) || TITULO_COLGADO.test(fold(title))) continue;
    const r = parseDirecto(`${head}${fecha} ${title}`, now, timeZone);
    if (r && r.title === title) return r;
  }
  return null;
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
  if (!RE.test(horaHablada(said.text))) {
    const esta = estaDelante(original);
    return (
      tituloDelante(original, now, timeZone) ??
      horaDetras(original, now, timeZone) ??
      (esta ? horaDetras(esta, now, timeZone) : null)
    );
  }
  return parseDirecto(original, now, timeZone);
}

/**
 * «esta noche cine a las 22», «esta tarde pádel a las 7», «esta mañana médico a las 11:30»:
 * la parte del día delante y la hora detrás del título. Se lee como «hoy cine a las 22 de
 * la noche» (la parte del día va con la hora: «a las 7» de esta tarde son las 19:00). Antes
 * solo valía con la hora pegada («esta noche a las 10 cena») y si no, «No he pillado la
 * fecha». null si no es eso.
 */
function estaDelante(original: string): string | null {
  const folded = fold(original);
  const m =
    /^(\s*(?:(?:add|anadir|apunta(?:me)?)\s+)?)esta\s+(manana|tarde|noche)\s+(?!a\s+las?\s)/.exec(
      folded,
    );
  if (!m) return null;
  const rest = original.slice(m[0].length);
  const time = TIME_IN.exec(fold(rest));
  if (!time?.[1]) return null;
  const end = (time.index ?? 0) + time[0].length;
  // La hora ya dice su parte («a las 10 de la noche», «8 pm»): se deja como está.
  const conParte = /\bde\s+la\b|[ap]\.?\s?m\.?$/.test(time[1])
    ? rest
    : `${rest.slice(0, end)} de la ${m[2] === 'manana' ? 'mañana' : m[2]}${rest.slice(end)}`;
  return `${original.slice(0, (m[1] ?? '').length)}hoy ${conParte}`;
}

const DAY_HEAD = new RegExp(String.raw`^${DAY}\s+`);
const TIME_IN = new RegExp(String.raw`(?:^|\s)(${TIME})(?=\s|$)`);

/**
 * La hora detrás del título: «el lunes reunión con Ana a las 9:30», «pasado mañana comida
 * con Luis a las 14», «mañana dentista a las 5 de la tarde». Antes se contestaba «No he
 * pillado la fecha o la hora». Se lee como «<día> <hora> <título>» y vale solo si el
 * título que sale es exactamente el resto (sin la hora).
 */
function horaDetras(
  original: string,
  now: Date,
  timeZone: string | undefined,
): { start: Date; title: string } | null {
  const folded = fold(original);
  const lead = (LEAD_RE.exec(folded)?.[1] ?? '').length;
  const day = DAY_HEAD.exec(folded.slice(lead));
  if (!day) return null;
  const restAt = lead + day[0].length;
  const time = TIME_IN.exec(folded.slice(restAt));
  if (!time?.[1]) return null;
  const timeAt = restAt + (time.index ?? 0) + time[0].length - time[1].length;
  const timeEnd = timeAt + time[1].length;
  // «de 9 a 11:30 curso»: un tramo, no un título con la hora detrás; se pregunta.
  if (TITULO_COLGADO.test(folded.slice(restAt, timeAt).trim())) return null;
  const title = `${original.slice(restAt, timeAt)} ${original.slice(timeEnd)}`
    .replace(/\s+/g, ' ')
    .replace(/[\s,;:.!-]+$/, '')
    .trim();
  // «el lunes 9 dentista a las 10»: el número es del día, no del título; se pregunta.
  if (!title || /^\d/.test(title) || TITULO_COLGADO.test(fold(title))) return null;
  if (/(?:^|\s)(?:de|desde|entre)\s+\d/.test(fold(title))) return null;
  const r = parseDirecto(
    `${original.slice(0, restAt)}${original.slice(timeAt, timeEnd)} ${title}`,
    now,
    timeZone,
  );
  return r && r.title === title ? r : null;
}

/** La fecha delante y el título detrás («mañana a las 9 dentista»). */
function parseDirecto(
  text: string,
  now: Date,
  timeZone: string | undefined,
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
  // «mañana a las 21 y 2 personas cena»: no son las 21:02, y el «y» no es del título.
  const title = original
    .slice(original.length - tail)
    .trim()
    .replace(/^y\s+(?=\d+\s+\p{L})/u, '');
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
  const start = new Date(zonedTime(y, mo, d, h, mi, timeZone));
  // «hoy a las 5 dentista» dicho a las 10: las 17:00, no una hora que ya pasó (antes
  // preguntaba «¿Lo apunto igualmente?» por las 5:00). Solo de 1 a 11, sin parte del día,
  // sin «pm» ni «05:00», con «hoy» o sin día (una fecha dicha, «el 2 de noviembre», se
  // pregunta como antes) y si la de la tarde aún no ha pasado; como los recordatorios (#2044).
  const sameDay =
    (word === 'hoy' || (!word && !m[2] && !m[3] && !m[6] && !m[9])) &&
    y === today.year &&
    mo === today.month &&
    d === today.day;
  const hourSaid = m[12] ?? m[14] ?? '';
  if (
    sameDay &&
    !part &&
    !m[17] &&
    h >= 1 &&
    h <= 11 &&
    !hourSaid.startsWith('0') &&
    !/\bhoras?\b|\d\s*h\b/i.test(original) &&
    start.getTime() < now.getTime()
  ) {
    const pm = new Date(zonedTime(y, mo, d, h + 12, mi, timeZone));
    if (pm.getTime() > now.getTime()) return { start: pm, title };
  }
  return { start, title };
}

/**
 * /calendario con solo la hora: «a las 18 llamada con Juan», «a las 9:30 dentista». Hoy si
 * aún no ha pasado y, si no, mañana. Antes contestaba «No he pillado la fecha o la hora».
 * Solo para /calendario: los recordatorios ya tienen su propia regla para «a las 5».
 */
export function parseFechaCalendarioDicha(
  text: string,
  now: Date = new Date(),
  timeZone?: string,
): { start: Date; title: string } | null {
  const direct = parseFechaCalendario(text, now, timeZone);
  if (direct) return direct;
  const original = text.normalize('NFC').trim();
  const folded = fold(original);
  const lead = (LEAD_RE.exec(folded)?.[1] ?? '').length;
  if (!/^a\s+las?\s+\S/.test(folded.slice(lead))) return null;
  const head = original.slice(0, lead);
  const body = original.slice(lead);
  const hoy = parseFechaCalendario(`${head}hoy ${body}`, now, timeZone);
  if (hoy && hoy.start.getTime() > now.getTime()) return hoy;
  return parseFechaCalendario(`${head}mañana ${body}`, now, timeZone) ?? hoy;
}
