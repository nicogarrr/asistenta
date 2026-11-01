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

export function scheduleEs(schedule: string): string | null {
  const f = schedule.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [m = '', h = '', dom = '', mon = '', dow = ''] = f;
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
  const day = num(dom, 31);
  if (day === null || dow !== '*') return null;
  if (mon === '*') return `cada mes el día ${day} ${at}`;
  const month = num(mon, 12);
  return month === null ? null : `cada año el ${pad(day)}/${pad(month)} ${at}`;
}
