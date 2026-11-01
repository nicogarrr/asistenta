import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MINUTES_AFTER, MINUTES_BEFORE, minuteSaid } from '../cron/scheduler.js';
import { setAsideCorrupt, writeFileReplacing } from '../fs-tmp.js';

/**
 * Tablero semanal de tareas: «apúntame para el jueves llamar al banco», «¿qué tengo esta
 * semana?», «marca hecho lo del banco». Un JSON pequeño en el estado local; nada sale a la
 * red. Las horas son solo anotación: el aviso a esa hora lo pone la herramienta de
 * recordatorios si el dueño lo quiere (no hay un segundo sistema de avisos aquí).
 */

export type TaskStatus = 'pendiente' | 'en_curso' | 'hecho';
export type TaskRepeat = 'diario' | 'laborables' | 'semanal' | 'quincenal' | 'mensual';

export const REPEAT_LABEL: Record<TaskRepeat, string> = {
  diario: 'cada día',
  laborables: 'de lunes a viernes',
  semanal: 'cada semana',
  quincenal: 'cada dos semanas',
  mensual: 'cada mes',
};

export interface BoardTask {
  id: number;
  /** Chat al que pertenece (la clave del hilo sin el «#hilo»). */
  scope: string;
  title: string;
  /** Día local, AAAA-MM-DD. */
  day: string;
  /** Hora local HH:MM, opcional. */
  time?: string;
  /** Se repite: al hacerla (o si se pasa su día) salta a la siguiente. */
  repeat?: TaskRepeat;
  status: TaskStatus;
  /** Día en que el resumen de la mañana avisó de que iba atrasada (se avisa una sola vez). */
  lateNoticeDay?: string;
  createdAt: string;
  updatedAt: string;
}

interface BoardFile {
  nextId: number;
  tasks: BoardTask[];
}

const MAX_TASKS = 2000;

export const STATUS_LABEL: Record<TaskStatus, string> = {
  pendiente: 'pendiente',
  en_curso: 'en curso',
  hecho: 'hecho',
};

const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const WEEKDAY_LABEL = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Día local de una fecha, AAAA-MM-DD. */
export function localDay(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

function parseDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12);
}

/** ¿Existe ese día en el calendario? «2026-02-29» no, «2028-02-29» sí. */
function realDay(day: string): boolean {
  const [y, m, d] = day.split('-').map(Number);
  const at = parseDay(day);
  return at.getFullYear() === y && at.getMonth() + 1 === m && at.getDate() === d;
}

function addDays(day: string, n: number): string {
  const at = parseDay(day);
  at.setDate(at.getDate() + n);
  return localDay(at);
}

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
const NUMBER_WORDS = [
  'cero',
  'una',
  'dos',
  'tres',
  'cuatro',
  'cinco',
  'seis',
  'siete',
  'ocho',
  'nueve',
  'diez',
  'once',
  'doce',
];

/** «una», «un», «dos»… o cifras → número; si no, NaN. */
function smallNumber(word: string): number {
  if (/^\d+$/.test(word)) return Number(word);
  if (word === 'un' || word === 'uno') return 1;
  // «dentro de quince días»: lo que se dice de verdad (gaps8).
  if (word === 'quince') return 15;
  if (word === 'veinte') return 20;
  if (word === 'treinta') return 30;
  const i = NUMBER_WORDS.indexOf(word);
  return i === -1 ? Number.NaN : i;
}

/** «12 de noviembre (de 2027)», con mes abreviado («dic»); sin año y ya pasado: el año que viene. */
function monthNameDay(text: string, now: Date): string | null | undefined {
  const m = /^(?:dia\s+)?(\d{1,2})\s+de\s+([a-z]+)\.?(?:\s+(?:de|del)\s+(\d{4}))?$/.exec(text);
  if (!m) return undefined;
  const name = (m[2] ?? '').replace(/^setiembre$/, 'septiembre');
  const month = name.length >= 3 ? MONTHS.findIndex((x) => x.startsWith(name)) : -1;
  if (month === -1) return null;
  const d = Number(m[1]);
  let y = m[3] ? Number(m[3]) : now.getFullYear();
  let day = `${y}-${pad(month + 1)}-${pad(d)}`;
  if (localDay(parseDay(day)) !== day) return null;
  if (!m[3] && day < localDay(now)) {
    y += 1;
    day = `${y}-${pad(month + 1)}-${pad(d)}`;
    if (localDay(parseDay(day)) !== day) return null;
  }
  return day;
}

/**
 * «todos los lunes», «los lunes», «cada día», «de lunes a viernes», «cada dos semanas»,
 * «cada mes»; «no» = dejar de repetir.
 */
export function resolveRepeat(input: string): TaskRepeat | 'no' | null {
  const t = fold(input);
  if (/^(?:no|nunca|ninguna|sin repetir|no repetir|dejar de repetir)$/.test(t)) return 'no';
  if (/laborables|de lunes a viernes|entre semana/.test(t)) return 'laborables';
  if (/^(?:diari[oa]|cada dia|todos los dias|a diario)$/.test(t)) return 'diario';
  if (
    /^(?:semanal|cada semana|todas las semanas|(?:todos los|cada) (?:lunes|martes|miercoles|jueves|viernes|sabados?|domingos?))$/.test(
      t,
    ) ||
    // «los lunes» sin «todos»/«cada» (gaps9): en plural es cada semana.
    /^los (?:lunes|martes|miercoles|jueves|viernes|sabados|domingos)$/.test(t)
  )
    return 'semanal';
  if (
    /^(?:quincenal|cada (?:dos|2) semanas|cada (?:quince|15) dias|(?:una )?semana si,? (?:y )?(?:otra|semana) no)$/.test(
      t,
    )
  )
    return 'quincenal';
  if (/^(?:mensual|cada mes|todos los meses)$/.test(t)) return 'mensual';
  return null;
}

/** El siguiente día de una tarea que se repite. */
export function nextOccurrence(day: string, repeat: TaskRepeat): string {
  if (repeat === 'diario') return addDays(day, 1);
  if (repeat === 'semanal') return addDays(day, 7);
  if (repeat === 'quincenal') return addDays(day, 14);
  if (repeat === 'laborables') {
    let next = addDays(day, 1);
    while ([0, 6].includes(parseDay(next).getDay())) next = addDays(next, 1);
    return next;
  }
  const [y, m, d] = day.split('-').map(Number);
  const at = new Date(y ?? 1970, m ?? 1, 1, 12); // día 1 del mes siguiente
  const last = new Date(at.getFullYear(), at.getMonth() + 1, 0).getDate();
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(Math.min(d ?? 1, last))}`;
}

/** Lunes de la semana del día dado. */
export function weekStart(day: string): string {
  const dow = parseDay(day).getDay();
  return addDays(day, -((dow + 6) % 7));
}

/** «jueves 5» */
export function dayLabel(day: string): string {
  const at = parseDay(day);
  return `${WEEKDAY_LABEL[at.getDay()]} ${at.getDate()}`;
}

/** «la semana que viene», «la próxima semana», «para la semana siguiente». */
export function saysNextWeek(input: string): boolean {
  const t = fold(input)
    .trim()
    .replace(/^(?:para\s+)?(?:la\s+)?/, '');
  return /^(?:semana que viene|proxima semana|semana proxima|siguiente semana|semana siguiente)$/.test(
    t,
  );
}

/**
 * Convierte lo que dice el dueño en un día: «hoy», «mañana», «pasado mañana», «jueves»,
 * «el jueves que viene», «próximo lunes», «5/11», «2026-11-05». Un día de la semana sin
 * más es el próximo (hoy incluido). Devuelve null si no lo entiende.
 */
export function resolveDay(input: string, now: Date): string | null {
  const today = localDay(now);
  const said = fold(input).trim();
  // «esta mañana», «esta tarde», «esta noche» son hoy: antes, «esta mañana» quedaba
  // en «mañana» y la tarea se iba al día siguiente (gaps8).
  if (/^(?:para\s+)?esta\s+(?:manana|tarde|noche)$/.test(said)) return today;
  // «mañana por la tarde», «hoy por la noche»: la parte del día no cambia el día.
  const part = /^(.+?)\s+(?:por|a|de)\s+la\s+(?:manana|tarde|noche)$/.exec(said);
  if (part?.[1] && /^(?:hoy|manana|pasado manana)$/.test(part[1])) return resolveDay(part[1], now);
  const text = said.replace(/^(el|este|esta|para el|para)\s+/, '');
  // «2026-02-30» o «2026-13-01»: Date los pasa al mes siguiente sin avisar, y la tarea
  // quedaba guardada en un día que no existe y no salía en ninguna vista.
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return realDay(text) ? text : null;
  if (text === 'hoy') return today;
  if (text === 'manana') return addDays(today, 1);
  if (text === 'pasado manana') return addDays(today, 2);
  // «la semana que viene»: el lunes de esa semana; «el mes que viene»: su día 1 (gaps9).
  if (saysNextWeek(text)) return addDays(weekStart(today), 7);
  if (/^(?:mes que viene|proximo mes|mes proximo|siguiente mes|mes siguiente)$/.test(text)) {
    const first = new Date(now.getFullYear(), now.getMonth() + 1, 1, 12);
    return `${first.getFullYear()}-${pad(first.getMonth() + 1)}-01`;
  }
  const within = /^(?:dentro de|en)\s+(\w+)\s+(dias?|semanas?|mes(?:es)?)$/.exec(text);
  if (within) {
    const n = smallNumber(within[1] ?? '');
    if (!Number.isInteger(n) || n < 0 || n > 366) return null;
    if (within[2]?.startsWith('mes')) {
      // «dentro de un mes»: el mismo día N meses después (el 31 se queda en el último día).
      if (n > 24) return null;
      const at = new Date(now.getFullYear(), now.getMonth() + n, 1, 12);
      const last = new Date(at.getFullYear(), at.getMonth() + 1, 0).getDate();
      return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(Math.min(now.getDate(), last))}`;
    }
    return addDays(today, within[2]?.startsWith('semana') ? n * 7 : n);
  }
  if (/^(?:fin de semana|finde)$/.test(text)) {
    return now.getDay() === 0 ? today : addDays(today, (6 - now.getDay() + 7) % 7);
  }
  // «el finde que viene», «el próximo fin de semana»: el sábado de la semana que viene (gaps9).
  if (
    /^(?:(?:fin de semana|finde)\s+(?:que viene|proximo|siguiente)|(?:proximo|siguiente)\s+(?:fin de semana|finde))$/.test(
      text,
    )
  ) {
    return addDays(weekStart(today), 12);
  }
  // «jueves 12 (de noviembre)»: manda el número.
  const dated = text.replace(
    /^(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo)\s+(?=\d)/,
    '',
  );
  if (dated !== text) return resolveDay(dated, now);
  const named = monthNameDay(text, now);
  if (named !== undefined) return named;
  // «15/11», «15-11-2026», «15.11.2026»: barra, guion o punto (el mismo en toda la fecha).
  const dm = /^(?:dia\s+)?(\d{1,2})(?:([/.-])(\d{1,2})(?:\2(\d{2,4}))?)?$/.exec(text);
  if (dm) {
    const d = Number(dm[1]);
    let m = dm[3] ? Number(dm[3]) : now.getMonth() + 1;
    let y = dm[4] ? Number(dm[4]) : now.getFullYear();
    if (y < 100) y += 2000;
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    let day = `${y}-${pad(m)}-${pad(d)}`;
    // «el 1/1» dicho en noviembre sin año: el que viene, como «el 1 de enero». Antes la
    // tarea quedaba en el 1 de enero que ya pasó.
    if (dm[3] && !dm[4] && day < today) {
      y += 1;
      day = `${y}-${pad(m)}-${pad(d)}`;
    }
    if (localDay(parseDay(day)) !== day) return null;
    // «el 3» sin mes ni año ya pasado este mes: el del mes que viene.
    if (!dm[3] && day < today) {
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
      day = `${y}-${pad(m)}-${pad(d)}`;
      if (localDay(parseDay(day)) !== day) return null;
    }
    return day;
  }
  const next = /^(?:proximo\s+)?(\w+)(\s+que viene|\s+de la semana que viene)?$/.exec(text);
  if (next) {
    const target = WEEKDAYS.indexOf(next[1] ?? '');
    if (target === -1) return null;
    const nextWeek = text.startsWith('proximo') || Boolean(next[2]);
    if (nextWeek) return addDays(weekStart(today), 7 + ((target + 6) % 7));
    const delta = (target - now.getDay() + 7) % 7;
    return addDays(today, delta);
  }
  return null;
}

export function resolveStatus(input: string): TaskStatus | null {
  const t = fold(input);
  if (/^(hech[oa]s?|terminad[oa]|acabad[oa]|completad[oa]|lista?|done)$/.test(t)) return 'hecho';
  if (/^(en curso|empezad[oa]|haciendo(lo|la)?|en marcha|en ello)$/.test(t)) return 'en_curso';
  if (/^(pendiente|por hacer|sin hacer|abiert[oa])$/.test(t)) return 'pendiente';
  return null;
}

export function normaliseTime(input: string | undefined): string | undefined | null {
  if (input === undefined || input.trim() === '') return undefined;
  let t = fold(input)
    .replace(/^(?:a|sobre|hacia|para)\s+/, '')
    .replace(/^(?:las|la)\s+/, '');
  if (t === 'mediodia') return '12:00';
  if (t === 'medianoche') return '00:00';
  // «5 de la tarde», «9 de la noche», «5pm», «10 de la mañana».
  const period = /\s*(?:(?:de|por) la (manana|tarde|noche|madrugada)|([ap])\.?\s?m\.?)$/.exec(t);
  const pm = period ? period[1] === 'tarde' || period[1] === 'noche' || period[2] === 'p' : false;
  if (period) t = t.slice(0, period.index).trim();
  let extra = 0;
  t = t.replace(/\s+en punto$/, '');
  // «8 y media», «8 y diez», «8 y 15», «9 menos veinte», «9 y treinta y cinco»: before,
  // only media/cuarto were read and «a las 8 y diez» was refused (gaps8).
  const frac = new RegExp(`\\s+(?:y\\s+(${MINUTES_AFTER})|menos\\s+(${MINUTES_BEFORE}))$`).exec(t);
  if (frac) {
    const said = minuteSaid(frac[1] ?? frac[2] ?? '');
    if (frac[2] !== undefined ? !(said >= 1 && said <= 30) : !(said >= 0 && said <= 59))
      return null;
    extra = frac[2] !== undefined ? -said : said === 0 ? 60 : said;
    t = t.slice(0, frac.index);
  }
  const word = /^[a-z]+$/.test(t) ? smallNumber(t) : Number.NaN;
  if (!Number.isNaN(word)) t = String(word);
  const m = /^(\d{1,2})(?:[:.h](\d{2}))?h?$/.exec(t.replace(/\s/g, ''));
  if (!m) return null;
  let h = Number(m[1]);
  let min = Number(m[2] ?? '0');
  if (h > 23 || min > 59) return null;
  if (period && h > 12) return pm ? `${pad(h)}:${pad(min)}` : null;
  const night = period?.[1] === 'noche' || period?.[1] === 'madrugada';
  // «12 de la noche» / «12am» es medianoche; «la una de la noche» es la 1:00, no las 13:00.
  if (h === 12 && (night || period?.[2] === 'a')) h = 0;
  else if (pm && h < 12 && !(night && h <= 4)) h += 12;
  if (extra) {
    if (m[2]) return null;
    min = extra === 60 ? 0 : extra > 0 ? extra : 60 + extra;
    if (extra < 0) h = (h + 23) % 24;
  }
  return `${pad(h)}:${pad(min)}`;
}

const STOP = new Set(['lo', 'la', 'el', 'los', 'las', 'de', 'del', 'que', 'a', 'al', 'tarea']);

function words(text: string): string[] {
  return fold(text)
    .split(/[^a-z0-9ñ]+/)
    .filter((w) => w && !STOP.has(w));
}

export const chatScope = (scope: string): string => scope.split('#')[0] ?? scope;

export class TaskBoard {
  readonly file: string;
  readonly now: () => Date;

  constructor(file: string, now: () => Date = () => new Date()) {
    this.file = file;
    this.now = now;
  }

  #read(): BoardFile {
    if (!existsSync(this.file)) return { nextId: 1, tasks: [] };
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<BoardFile>;
      const tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
      const maxId = tasks.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0);
      // Una repetida sin hacer no se acumula atrasada: pasa a la próxima desde hoy.
      const today = this.today();
      for (const t of tasks) {
        if (!t.repeat || !REPEAT_LABEL[t.repeat] || t.status === 'hecho') continue;
        for (let i = 0; t.day < today && i < 400; i++) t.day = nextOccurrence(t.day, t.repeat);
        delete t.lateNoticeDay;
      }
      return { nextId: Math.max(Number(raw.nextId) || 1, maxId + 1), tasks };
    } catch {
      setAsideCorrupt(this.file);
      return { nextId: 1, tasks: [] };
    }
  }

  #write(data: BoardFile): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileReplacing(this.file, `${JSON.stringify(data, null, 1)}\n`);
  }

  today(): string {
    return localDay(this.now());
  }

  add(scope: string, title: string, day: string, time?: string, repeat?: TaskRepeat): BoardTask {
    const data = this.#read();
    const at = this.now().toISOString();
    const task: BoardTask = {
      id: data.nextId,
      scope: chatScope(scope),
      title: title.trim().slice(0, 200),
      day,
      ...(time ? { time } : {}),
      ...(repeat ? { repeat } : {}),
      status: 'pendiente',
      createdAt: at,
      updatedAt: at,
    };
    data.nextId += 1;
    data.tasks.push(task);
    // Tope: se van primero las hechas más antiguas.
    while (data.tasks.length > MAX_TASKS) {
      const old = data.tasks.findIndex((t) => t.status === 'hecho');
      data.tasks.splice(old === -1 ? 0 : old, 1);
    }
    this.#write(data);
    return task;
  }

  all(scope?: string): BoardTask[] {
    const tasks = this.#read().tasks;
    const key = scope === undefined ? undefined : chatScope(scope);
    return tasks
      .filter((t) => key === undefined || t.scope === key)
      .sort(
        (a, b) =>
          a.day.localeCompare(b.day) ||
          (a.time ?? '99').localeCompare(b.time ?? '99') ||
          a.id - b.id,
      );
  }

  /** Tareas de la semana (lunes a domingo) que contiene `day`, más las pendientes atrasadas. */
  week(
    scope: string | undefined,
    day = this.today(),
  ): { from: string; to: string; tasks: BoardTask[]; overdue: BoardTask[] } {
    const from = weekStart(day);
    const to = addDays(from, 6);
    const all = this.all(scope);
    const today = this.today();
    return {
      from,
      to,
      tasks: all.filter((t) => t.day >= from && t.day <= to),
      overdue: all.filter((t) => t.day < from && t.day < today && t.status !== 'hecho'),
    };
  }

  /** Busca por número («3») o por palabras («lo del banco»). */
  find(scope: string, ref: string): BoardTask[] {
    const all = this.all(scope);
    const n = /^#?(\d+)$/.exec(ref.trim());
    if (n) return all.filter((t) => t.id === Number(n[1]));
    const want = words(ref);
    if (want.length === 0) return [];
    return all.filter((t) => {
      const have = words(t.title);
      return want.every((w) => have.some((h) => h.startsWith(w) || w.startsWith(h)));
    });
  }

  /**
   * Cambia el estado. Si una que se repite queda hecha, se apunta la siguiente (que
   * devuelve en `next`) y la hecha deja de repetirse.
   */
  setStatus(id: number, status: TaskStatus): (BoardTask & { next?: BoardTask }) | undefined {
    const done = this.#update(id, (t) => {
      t.status = status;
    });
    if (!done?.repeat || status !== 'hecho') return done;
    const repeat = done.repeat;
    this.#update(id, (t) => {
      delete t.repeat;
    });
    let day = nextOccurrence(done.day, repeat);
    while (day < this.today()) day = nextOccurrence(day, repeat);
    const next = this.add(done.scope, done.title, day, done.time, repeat);
    return { ...done, next };
  }

  setRepeat(id: number, repeat: TaskRepeat | undefined): BoardTask | undefined {
    return this.#update(id, (t) => {
      if (repeat) t.repeat = repeat;
      else delete t.repeat;
    });
  }

  rename(id: number, title: string): BoardTask | undefined {
    return this.#update(id, (t) => {
      t.title = title.trim().slice(0, 200);
    });
  }

  /** Cambia el día (y la hora si viene; `null` le quita la hora). */
  move(id: number, day: string, time?: string | null): BoardTask | undefined {
    return this.#update(id, (t) => {
      t.day = day;
      if (time) t.time = time;
      else if (time === null) delete t.time;
      // Con fecha nueva puede volver a atrasarse, y entonces se avisa otra vez (una).
      delete t.lateNoticeDay;
    });
  }

  /** Apunta que hoy se avisó de estas tareas atrasadas; las ya apuntadas no cambian. */
  noteLate(ids: readonly number[], day = this.today()): void {
    if (ids.length === 0) return;
    const data = this.#read();
    let changed = false;
    for (const t of data.tasks) {
      if (ids.includes(t.id) && !t.lateNoticeDay) {
        t.lateNoticeDay = day;
        changed = true;
      }
    }
    if (changed) this.#write(data);
  }

  remove(id: number): BoardTask | undefined {
    const data = this.#read();
    const i = data.tasks.findIndex((t) => t.id === id);
    if (i === -1) return undefined;
    const [gone] = data.tasks.splice(i, 1);
    this.#write(data);
    return gone;
  }

  #update(id: number, change: (t: BoardTask) => void): BoardTask | undefined {
    const data = this.#read();
    const task = data.tasks.find((t) => t.id === id);
    if (!task) return undefined;
    change(task);
    task.updatedAt = this.now().toISOString();
    this.#write(data);
    return task;
  }
}

/**
 * Para el resumen de la mañana: lo de hoy sin hacer y lo atrasado, como mucho `max`.
 * Una tarea atrasada sale el primer día que se ve atrasada (y ese mismo día si el resumen
 * se repite), no cada mañana: sigue en el tablero y en el panel, pero no se insiste.
 */
export function briefingTasks(
  board: Pick<TaskBoard, 'all' | 'today' | 'noteLate'>,
  scope: string,
  max = 8,
): Array<{ title: string; time?: string; late?: boolean }> {
  const today = board.today();
  const picked = board
    .all(scope)
    .filter((t) => t.status !== 'hecho' && t.day <= today)
    .filter((t) => t.day === today || !t.lateNoticeDay || t.lateNoticeDay === today)
    .slice(0, max);
  board.noteLate(
    picked.filter((t) => t.day < today).map((t) => t.id),
    today,
  );
  return picked.map((t) => ({
    title: t.title,
    ...(t.day === today && t.time ? { time: t.time } : {}),
    ...(t.day < today ? { late: true } : {}),
  }));
}
