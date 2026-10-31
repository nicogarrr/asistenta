import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { setAsideCorrupt, writeFileReplacing } from '../fs-tmp.js';

/**
 * Tablero semanal de tareas: «apúntame para el jueves llamar al banco», «¿qué tengo esta
 * semana?», «marca hecho lo del banco». Un JSON pequeño en el estado local; nada sale a la
 * red. Las horas son solo anotación: el aviso a esa hora lo pone la herramienta de
 * recordatorios si el dueño lo quiere (no hay un segundo sistema de avisos aquí).
 */

export type TaskStatus = 'pendiente' | 'en_curso' | 'hecho';

export interface BoardTask {
  id: number;
  /** Chat al que pertenece (la clave del hilo sin el «#hilo»). */
  scope: string;
  title: string;
  /** Día local, AAAA-MM-DD. */
  day: string;
  /** Hora local HH:MM, opcional. */
  time?: string;
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

/**
 * Convierte lo que dice el dueño en un día: «hoy», «mañana», «pasado mañana», «jueves»,
 * «el jueves que viene», «próximo lunes», «5/11», «2026-11-05». Un día de la semana sin
 * más es el próximo (hoy incluido). Devuelve null si no lo entiende.
 */
export function resolveDay(input: string, now: Date): string | null {
  const today = localDay(now);
  const text = fold(input).replace(/^(el|este|esta|para el|para)\s+/, '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return Number.isNaN(parseDay(text).getTime()) ? null : text;
  if (text === 'hoy') return today;
  if (text === 'manana') return addDays(today, 1);
  if (text === 'pasado manana') return addDays(today, 2);
  const within = /^(?:dentro de|en)\s+(\w+)\s+(dias?|semanas?)$/.exec(text);
  if (within) {
    const n = smallNumber(within[1] ?? '');
    if (!Number.isInteger(n) || n < 0 || n > 366) return null;
    return addDays(today, within[2]?.startsWith('semana') ? n * 7 : n);
  }
  if (/^(?:fin de semana|finde)$/.test(text)) {
    return now.getDay() === 0 ? today : addDays(today, (6 - now.getDay() + 7) % 7);
  }
  // «jueves 12 (de noviembre)»: manda el número.
  const dated = text.replace(
    /^(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo)\s+(?=\d)/,
    '',
  );
  if (dated !== text) return resolveDay(dated, now);
  const named = monthNameDay(text, now);
  if (named !== undefined) return named;
  const dm = /^(?:dia\s+)?(\d{1,2})(?:\/(\d{1,2})(?:\/(\d{2,4}))?)?$/.exec(text);
  if (dm) {
    const d = Number(dm[1]);
    let m = dm[2] ? Number(dm[2]) : now.getMonth() + 1;
    let y = dm[3] ? Number(dm[3]) : now.getFullYear();
    if (y < 100) y += 2000;
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    let day = `${y}-${pad(m)}-${pad(d)}`;
    if (localDay(parseDay(day)) !== day) return null;
    // «el 3» sin mes ni año ya pasado este mes: el del mes que viene.
    if (!dm[2] && day < today) {
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
  const frac = /\s+(y media|y cuarto|menos cuarto)$/.exec(t);
  if (frac) {
    extra = frac[1] === 'y media' ? 30 : frac[1] === 'y cuarto' ? 15 : -15;
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
  if (pm && h < 12) h += 12;
  if (extra) {
    if (m[2]) return null;
    min = extra > 0 ? extra : 45;
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

  add(scope: string, title: string, day: string, time?: string): BoardTask {
    const data = this.#read();
    const at = this.now().toISOString();
    const task: BoardTask = {
      id: data.nextId,
      scope: chatScope(scope),
      title: title.trim().slice(0, 200),
      day,
      ...(time ? { time } : {}),
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

  setStatus(id: number, status: TaskStatus): BoardTask | undefined {
    return this.#update(id, (t) => {
      t.status = status;
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
