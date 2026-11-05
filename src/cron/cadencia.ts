import { skipsHolidays } from '../festivos-rutinas.js';
import { foldAccents } from '../text.js';
import { scheduleEs } from './describe-es.js';

/**
 * «cada 2 días», «cada dos semanas el lunes», «día sí, día no»: un cron no lo dice (con
 * «*\/2» en el día del mes, el 31 y el 1 suenan seguidos). La rutina se guarda con el cron
 * de cada día (o de cada lunes) y sus palabras, como «excepto festivos»
 * (festivos-rutinas.ts): al sonar, RoutineRunner mira cuándo fue la última vez y se salta
 * los huecos que caen antes de tiempo. Antes /cron preguntaba «no entiendo ese horario».
 */
export interface Cadencia {
  /** Cada cuántos días o semanas. */
  n: number;
  unidad: 'dia' | 'semana';
}

const DAY_MS = 24 * 60 * 60_000;

const NUMBER_WORD: Record<string, number> = {
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
  trece: 13,
  catorce: 14,
  quince: 15,
  veinte: 20,
  treinta: 30,
};
const NUMBER = `\\d{1,2}|${Object.keys(NUMBER_WORD).join('|')}`;

const CADA_N = new RegExp(`\\bcada (${NUMBER}) (dias|semanas)\\b`);
const DIA_SI_NO =
  /\b(?:(?:un |cada )?dia si,? (?:y )?(?:otro|dia) no|en dias alternos|a dias alternos)\b/;
const SEMANA_SI_NO =
  /\b(?:(?:una |cada )?semana si,? (?:y )?(?:otra|semana) no|en semanas alternas)\b/;
const DAY_NAME = /\b(?:los |el )?(?:lunes|martes|miercoles|jueves|viernes|sabados?|domingos?)\b/;
const WEEKDAY_SAID = '(lunes|martes|miercoles|jueves|viernes|sabados?|domingos?)';
/**
 * «cada dos lunes», «cada 2 viernes», «lunes alternos», «un lunes sí y otro no»: cada dos
 * semanas ese día. Antes «cada dos lunes a las 9» sonaba todos los días a las 9.
 */
const CADA_N_DIA = new RegExp(`\\bcada (${NUMBER}) ${WEEKDAY_SAID}\\b`);
const DIA_ALTERNO = new RegExp(
  `\\b(?:(?:los |en |cada )?${WEEKDAY_SAID} alternos|(?:un |cada )?${WEEKDAY_SAID} si,? (?:y )?(?:otro|\\w+) no)\\b`,
);

const fold = (text: string): string => foldAccents(text).toLowerCase().replace(/\s+/g, ' ');

/** Dónde lo dice y qué cadencia, o null si no pide «cada N días/semanas». */
function find(
  text: string,
): { cadencia: Cadencia; start: number; end: number; swap?: string } | null {
  const t = fold(text);
  const w = CADA_N_DIA.exec(t);
  if (w) {
    const said = w[1] ?? '';
    const n = /^\d+$/.test(said) ? Number(said) : (NUMBER_WORD[said] ?? 0);
    if (n < 2 || n > 8) return null;
    const day = (w[2] ?? '').replace(/(sabado|domingo)s$/, '$1');
    return {
      cadencia: { n, unidad: 'semana' },
      start: w.index,
      end: w.index + w[0].length,
      swap: `cada ${day}`,
    };
  }
  const a = DIA_ALTERNO.exec(t);
  if (a) {
    const day = (a[1] ?? a[2] ?? '').replace(/(sabado|domingo)s$/, '$1');
    return {
      cadencia: { n: 2, unidad: 'semana' },
      start: a.index,
      end: a.index + a[0].length,
      swap: `cada ${day}`,
    };
  }
  const m = CADA_N.exec(t);
  if (m) {
    const said = m[1] ?? '';
    let n = /^\d+$/.test(said) ? Number(said) : (NUMBER_WORD[said] ?? 0);
    let unidad: Cadencia['unidad'] = m[2] === 'semanas' ? 'semana' : 'dia';
    // «cada 15 días el viernes» es «cada dos semanas»: con un día de la semana, 15 días
    // no caen nunca en viernes.
    if (unidad === 'dia' && (n === 14 || n === 15) && DAY_NAME.test(t)) {
      n = 2;
      unidad = 'semana';
    }
    const max = unidad === 'dia' ? 31 : 8;
    if (n < 2 || n > max) return null;
    return { cadencia: { n, unidad }, start: m.index, end: m.index + m[0].length };
  }
  const d = DIA_SI_NO.exec(t);
  if (d) return { cadencia: { n: 2, unidad: 'dia' }, start: d.index, end: d.index + d[0].length };
  const s = SEMANA_SI_NO.exec(t);
  if (s)
    return { cadencia: { n: 2, unidad: 'semana' }, start: s.index, end: s.index + s[0].length };
  return null;
}

/** La cadencia que piden las palabras de una rutina, o null. */
export function cadenciaDe(text: string | null | undefined): Cadencia | null {
  return text ? (find(text)?.cadencia ?? null) : null;
}

/**
 * El horario de una rutina dicha con cadencia: las palabras con «cada día» / «cada semana»
 * en lugar de «cada 2 días» / «cada 2 semanas», para leer la hora y el día con el lector de
 * siempre. null si no hay cadencia.
 */
export function sinCadencia(text: string): { cadencia: Cadencia; text: string } | null {
  const found = find(text);
  if (!found) return null;
  const t = fold(text);
  const swap = found.swap ?? (found.cadencia.unidad === 'dia' ? 'todos los dias' : 'cada semana');
  return {
    cadencia: found.cadencia,
    text: `${t.slice(0, found.start)}${swap}${t.slice(found.end)}`.replace(/\s+/g, ' ').trim(),
  };
}

/**
 * ¿Sirve esta cadencia con este cron? Solo una hora al día y, por semanas, un solo día de
 * la semana: con «a las 9 y a las 21» el segundo aviso del día caería «antes de tiempo».
 */
export function cadenciaEncaja(cadencia: Cadencia, schedule: string | null | undefined): boolean {
  const f = (schedule ?? '').trim().split(/\s+/);
  if (f.length !== 5) return false;
  const [m = '', h = '', dom = '', mon = '', dow = ''] = f;
  if (!/^\d{1,2}$/.test(m) || !/^\d{1,2}$/.test(h) || dom !== '*' || mon !== '*') return false;
  return cadencia.unidad === 'dia' ? dow === '*' : /^[0-7]$/.test(dow);
}

/** La cadencia de una rutina guardada (nombre y tarea) si encaja con su cron; si no, null. */
export function cadenciaDeRutina(routine: {
  name: string;
  prompt: string | null;
  schedule: string | null;
}): Cadencia | null {
  const cadencia = cadenciaDe(`${routine.name} ${routine.prompt ?? ''}`);
  return cadencia && cadenciaEncaja(cadencia, routine.schedule) ? cadencia : null;
}

/**
 * ¿Este hueco cae antes de tiempo? Sí si desde la última vez no ha pasado la cadencia,
 * con media unidad de margen (un retraso, el cambio de hora). Sin última vez, suena.
 */
export function fueraDeCadencia(
  cadencia: Cadencia,
  slot: Date,
  lastRunAt: string | null | undefined,
): boolean {
  const last = lastRunAt ? Date.parse(lastRunAt) : Number.NaN;
  if (!Number.isFinite(last)) return false;
  const unit = cadencia.unidad === 'dia' ? DAY_MS : 7 * DAY_MS;
  return slot.getTime() - last < cadencia.n * unit - unit / 2;
}

/**
 * El horario dicho con su cadencia: «cada día a las 09:00» → «cada 2 días a las 09:00»;
 * «cada lunes a las 09:00» → «cada 2 semanas, el lunes a las 09:00».
 */
export function cadenciaEs(cadencia: Cadencia, scheduleSaid: string): string {
  if (cadencia.unidad === 'dia') {
    return scheduleSaid.replace(/^cada día\b/, `cada ${cadencia.n} días`);
  }
  return `cada ${cadencia.n} semanas, ${scheduleSaid.replace(/^cada /, 'el ')}`;
}

/** El horario de una rutina en palabras, con su cadencia si la tiene; null si no se sabe decir. */
export function horarioRutinaEs(routine: {
  name: string;
  prompt: string | null;
  schedule: string | null;
}): string | null {
  const said = routine.schedule ? scheduleEs(routine.schedule) : null;
  if (!said) return null;
  const cadencia = cadenciaDeRutina(routine);
  return cadencia ? cadenciaEs(cadencia, said) : said;
}

/** «programada: cada 2 días a las 09:00», como programadaEs pero con la cadencia. */
export function programadaRutinaEs(routine: {
  name: string;
  prompt: string | null;
  schedule: string | null;
}): string {
  if (!routine.schedule) return 'programada';
  const said = horarioRutinaEs(routine);
  return said ? `programada: ${said}` : `programada con horario ${routine.schedule}`;
}

/**
 * El horario de una rutina en las listas (/cron, /agenda, /rutinas): en palabras
 * («de lunes a viernes a las 09:00, excepto festivos») y no el cron crudo («0 9 * * 1-5»),
 * que Nico no tiene por qué leer. Si no se sabe decir, el cron tal cual.
 */
export function horarioEnLista(r: {
  name: string;
  prompt: string | null;
  schedule: string | null;
}): string {
  if (!r.schedule) return 'sin horario';
  const said = horarioRutinaEs(r);
  if (!said) return r.schedule;
  return skipsHolidays(`${r.name} ${r.prompt ?? ''}`) ? `${said}, excepto festivos` : said;
}
