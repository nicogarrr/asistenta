/**
 * A 5-field cron schedule said in plain Spanish («cada lunes a las 08:30»), for lists
 * the owner reads. Returns null for anything it cannot say simply.
 */
const DAY = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const pad = (n: number): string => String(n).padStart(2, '0');
const num = (field: string, max: number): number | null =>
  /^\d{1,2}$/.test(field) && Number(field) <= max ? Number(field) : null;

function daysEs(dow: string): string | null {
  if (dow === '*') return 'cada día';
  if (dow === '1-5') return 'de lunes a viernes';
  const range = /^([0-6])-([0-6])$/.exec(dow);
  if (range && Number(range[1]) < Number(range[2]))
    return `de ${DAY[Number(range[1])]} a ${DAY[Number(range[2])]}`;
  const days = dow.split(',').map((d) => num(d, 7));
  if (days.some((d) => d === null)) return null;
  const names = [...new Set(days.map((d) => DAY[(d as number) % 7] as string))];
  if (names.length === 2 && names.includes('sábado') && names.includes('domingo'))
    return 'los fines de semana';
  if (names.length === 1) return `cada ${names[0]}`;
  // «de viernes a lunes»: three or more days in a row, round the weekend too.
  const order = days.map((x) => (x as number) % 7);
  if (
    order.length >= 3 &&
    order.every((x, i) => i === 0 || x === ((order[i - 1] as number) + 1) % 7)
  )
    return `de ${DAY[order[0] as number]} a ${DAY[order.at(-1) as number]}`;
  const plural = names.map((n) => (n.endsWith('s') ? n : `${n}s`));
  return `los ${plural.slice(0, -1).join(', ')} y ${plural.at(-1)}`;
}

const MONTH = [
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

/** «en diciembre», «de enero a marzo», «en julio y agosto»; null si no se sabe decir. */
function monthsEs(mon: string): string | null {
  const range = /^(\d{1,2})-(\d{1,2})$/.exec(mon);
  const list = range
    ? Array.from(
        { length: Number(range[2]) - Number(range[1]) + 1 },
        (_, i) => Number(range[1]) + i,
      )
    : mon.split(',').map(Number);
  if (list.length === 0 || list.some((x) => !Number.isInteger(x) || x < 1 || x > 12)) return null;
  const names = list.map((x) => MONTH[x - 1] as string);
  if (names.length === 1) return `en ${names[0]}`;
  const inRow = list.every((x, i) => i === 0 || x === ((list[i - 1] as number) % 12) + 1);
  if (inRow && names.length > 2) return `de ${names[0]} a ${names.at(-1)}`;
  return `en ${names.slice(0, -1).join(', ')} y ${names.at(-1)}`;
}

/** «cada 30 min de 09:00 a 14:00», «cada 2 horas de 08:00 a 20:00»; null si no se sabe decir. */
function intervalEs(m: string, h: string, minute: number | null): string | null {
  const range = /^(\d{1,2})-(\d{1,2})(?:\/(\d{1,2}))?$/.exec(h);
  const from = range ? num(range[1] ?? '', 23) : null;
  const to = range ? num(range[2] ?? '', 23) : null;
  if (range && (from === null || to === null || from >= to)) return null;
  if (minute === null) {
    const every = /^\*\/(\d{1,2})$/.exec(m);
    if (!every || (h !== '*' && (!range || range[3]))) return null;
    const base = `cada ${every[1]} min`;
    // «*/30 16-23» acaba a medianoche: «a 00:00», no «a 24:00».
    return range
      ? `${base} de ${pad(from as number)}:00 a ${pad(((to as number) + 1) % 24)}:00`
      : base;
  }
  const step = range ? range[3] : /^\*\/(\d{1,2})$/.exec(h)?.[1];
  const base = step ? `cada ${step} horas` : 'cada hora';
  if (!range) return h === '*' || step ? base : null;
  // «0 8-23/2» suena por última vez a las 22: esa es la hora que se dice, no las 23.
  const last =
    (from as number) +
    Math.floor(((to as number) - (from as number)) / Number(step ?? 1)) * Number(step ?? 1);
  return `${base} de ${pad(from as number)}:${pad(minute)} a ${pad(last)}:${pad(minute)}`;
}

export function scheduleEs(schedule: string): string | null {
  const f = schedule.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [m = '', h = '', dom = '', mon = '', dow = ''] = f;
  // «0 9 * 12 1»: rutina solo en unos meses («, en diciembre»). Antes salía el cron crudo.
  if (mon !== '*' && dom === '*') {
    const months = monthsEs(mon);
    const rest = scheduleEs([m, h, dom, '*', dow].join(' '));
    return months && rest ? `${rest}, ${months}` : null;
  }
  const minute = num(m, 59);
  // «9,21»: varias tomas al día («a las 9 y a las 21»). Antes no se sabía decir y la
  // lista ponía «se repite con un horario propio».
  const hours = /^\d{1,2}(?:,\d{1,2})+$/.test(h) ? h.split(',').map((x) => num(x, 23)) : null;
  if (minute !== null && hours && hours.every((x) => x !== null)) {
    const times = hours.map((x) => `${pad(x as number)}:${pad(minute)}`);
    const said = scheduleEs([m, '0', dom, mon, dow].join(' '));
    const at = `a las ${times.slice(0, -1).join(', ')} y ${times.at(-1)}`;
    return said ? said.replace(/a las \d{2}:\d{2}$/, at) : null;
  }
  const hour = num(h, 23);
  // «cada 30 min de 09:00 a 14:00, de lunes a viernes»: intervalo con franja o días.
  if (
    (minute === null || hour === null) &&
    dom === '*' &&
    mon === '*' &&
    (h !== '*' || dow !== '*')
  ) {
    const span = intervalEs(m, h, minute);
    const days = dow === '*' ? '' : daysEs(dow);
    return span && days !== null ? (days ? `${span}, ${days}` : span) : null;
  }
  if (minute === null) {
    const every = /^\*\/(\d{1,2})$/.exec(m);
    return every && h === '*' && dom === '*' && mon === '*' && dow === '*'
      ? `cada ${every[1]} min`
      : null;
  }
  if (hour === null) {
    const every = /^\*\/(\d{1,2})$/.exec(h);
    if (dom !== '*' || mon !== '*' || dow !== '*') return null;
    if (h === '*') return minute === 0 ? 'cada hora, en punto' : `cada hora, a los ${minute} min`;
    return every ? `cada ${every[1]} horas` : null;
  }
  const at = `a las ${pad(hour)}:${pad(minute)}`;
  if (dom === '*' && mon === '*') {
    const days = daysEs(dow);
    return days ? `${days} ${at}` : null;
  }
  // «0 9 1,15 * *»: varios días del mes («los días 1 y 15»). Antes salía el cron crudo.
  const days = /^\d{1,2}(?:,\d{1,2})+$/.test(dom) ? dom.split(',').map((x) => num(x, 31)) : null;
  if (days && mon === '*' && dow === '*' && days.every((x) => x !== null && x >= 1)) {
    return `cada mes los días ${days.slice(0, -1).join(', ')} y ${days.at(-1)} ${at}`;
  }
  const day = num(dom, 31);
  if (day === null || dow !== '*') return null;
  if (mon === '*') return `cada mes el día ${day} ${at}`;
  const month = num(mon, 12);
  return month === null ? null : `cada año el ${pad(day)}/${pad(month)} ${at}`;
}

/**
 * Al crear una rutina, el horario dicho en palabras: «programada: cada día a las
 * 09:00». Antes enseñaba el cron crudo («con horario 0 9 * * *»); el cron solo
 * queda si no se sabe decir.
 */
export function programadaEs(schedule: string | null): string {
  if (!schedule) return 'programada';
  const said = scheduleEs(schedule);
  return said ? `programada: ${said}` : `programada con horario ${schedule}`;
}
