import { localDay, wallClock, zonedTime } from './datecontext.js';
/**
 * El resumen proactivo del día, en texto plano y en español.
 *
 * No consulta nada: recibe lo que el resto del agente ya sabe (rutinas, seguimientos,
 * recordatorios y agenda) y lo reduce a cuatro bloques cortos. La brevedad es una
 * decisión de producto, no estética: un briefing que hay que leer dos veces es un
 * briefing que se ignora. Por eso las secciones vacías no se imprimen y el texto
 * entero se corta a 1800 caracteres.
 *
 * `briefingDue` responde a la otra mitad del problema: el daemon puede estar parado
 * a la hora configurada. Se envía una vez por día natural y, si las 08:00 pasaron
 * sin envío, se recupera en el primer chequeo posterior. Nunca se envía antes de la
 * hora configurada.
 */

/** Tope del mensaje completo. */
export const MAX_BRIEFING_CHARS = 1_800;

export interface BriefingInput {
  greeting: string;
  today: Date;
  routines: Array<{ name: string; nextRun?: string }>;
  followups: Array<{ subject: string; due?: string }>;
  reminders: Array<{ text: string; at?: string }>;
  agenda: Array<{ title: string; when: string }>;
  /** Una línea ya redactada con el tiempo de hoy («Madrid: 12–21 °C, despejado»). */
  weather?: string;
  /** Correo sin leer que merece mirarse hoy. Solo remitente y asunto, nunca el cuerpo. */
  mail?: Array<{ from: string; subject: string }>;
  /** Objetivos en marcha: el siguiente paso, o por qué están bloqueados. */
  goals?: Array<{ title: string; status: 'active' | 'blocked'; next?: string }>;
  /** Vigilancias de precio: último precio leído y, si lo hay, el objetivo. */
  watches?: Array<{ label: string; lastCents?: number | null; targetCents?: number | null }>;
}

const WEEKDAYS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function oneLine(value: string, max: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `domingo 25/10`, para el único caso en que el briefing habla del día sin agenda. */
function dayLabel(today: Date): string {
  if (Number.isNaN(today.getTime())) return 'hoy';
  const w = wallClock(today);
  return `${WEEKDAYS_ES[w.weekday] ?? 'día'} ${pad(w.day)}/${pad(w.month)}`;
}

function agendaLine(item: { title: string; when: string }): string | null {
  const title = oneLine(item.title, 140);
  if (!title) return null;
  const when = oneLine(item.when, 40);
  return when ? `${when}: ${title}` : title;
}

function routineLine(item: { name: string; nextRun?: string }): string | null {
  const name = oneLine(item.name, 120);
  if (!name) return null;
  const next = oneLine(item.nextRun ?? '', 60);
  return next ? `${name} (${next})` : name;
}

function reminderLine(item: { text: string; at?: string }): string | null {
  const text = oneLine(item.text, 160);
  if (!text) return null;
  const at = oneLine(item.at ?? '', 60);
  return at ? `${text} (${at})` : text;
}

function followupLine(item: { subject: string; due?: string }): string | null {
  const subject = oneLine(item.subject, 140);
  if (!subject) return null;
  const due = oneLine(item.due ?? '', 60);
  return due ? `${subject} (${due})` : subject;
}

function mailLine(item: { from: string; subject: string }): string | null {
  const subject = oneLine(item.subject, 140) || '(sin asunto)';
  const from = oneLine(item.from, 60);
  return from ? `${from}: ${subject}` : subject;
}

/** `129900` -> `1.299,00 €`, sin depender del ICU instalado. */
export function euros(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  const int = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}${int},${pad(abs % 100)} €`;
}

function goalLine(item: {
  title: string;
  status: 'active' | 'blocked';
  next?: string;
}): string | null {
  const title = oneLine(item.title, 120);
  if (!title) return null;
  const next = oneLine(item.next ?? '', 120);
  if (item.status === 'blocked') return `${title} (bloqueado${next ? `: ${next}` : ''})`;
  return next ? `${title}: ${next}` : title;
}

/** Bloqueado = espera una decisión de Nico, así que va primero. */
function goalSort(
  a: { status: 'active' | 'blocked' },
  b: { status: 'active' | 'blocked' },
): number {
  return (a.status === 'blocked' ? 0 : 1) - (b.status === 'blocked' ? 0 : 1);
}

export function watchHit(item: {
  lastCents?: number | null;
  targetCents?: number | null;
}): boolean {
  return (
    typeof item.lastCents === 'number' &&
    typeof item.targetCents === 'number' &&
    item.lastCents <= item.targetCents
  );
}

function watchLine(item: {
  label: string;
  lastCents?: number | null;
  targetCents?: number | null;
}): string | null {
  const label = oneLine(item.label, 100);
  if (!label) return null;
  const last = typeof item.lastCents === 'number' ? euros(item.lastCents) : 'sin lectura aún';
  const target =
    typeof item.targetCents === 'number' ? ` (objetivo ${euros(item.targetCents)})` : '';
  return `${watchHit(item) ? '¡' : ''}${label}: ${last}${target}${watchHit(item) ? ', ya está por debajo!' : ''}`;
}

function section(items: Array<string | null>): string[] {
  return items.filter((item): item is string => item !== null);
}

/** Corta por línea cuando se puede; si no, corta el texto y añade puntos suspensivos. */
function clamp(text: string): string {
  if (text.length <= MAX_BRIEFING_CHARS) return text;
  const room = MAX_BRIEFING_CHARS - 1;
  const cut = text.slice(0, room);
  const lastBreak = cut.lastIndexOf('\n');
  // Cortar una lista por la mitad deja una línea a medias; un salto de línea cercano
  // al final es preferible, aunque se pierda algo de texto.
  const body = lastBreak >= Math.floor(room * 0.6) ? cut.slice(0, lastBreak) : cut;
  return `${body.trimEnd()}…`;
}

/**
 * Construye el briefing. Las secciones van en orden fijo (Hoy, Correo, Pendiente,
 * Recordatorios, Seguimientos, Objetivos, Precios; el tiempo, si lo hay, va pegado al saludo) para que el mismo día
 * se lea siempre igual; las que no tienen contenido no aparecen.
 */
export function buildBriefing(input: BriefingInput): string {
  const greeting = oneLine(input.greeting, 120) || 'Hola';
  const blocks: Array<{ title: string; items: string[] }> = [
    {
      title: 'Hoy',
      items: section(input.agenda.map(agendaLine)),
    },
    {
      title: 'Correo',
      items: section((input.mail ?? []).map(mailLine)),
    },
    {
      title: 'Pendiente',
      items: section(input.routines.map(routineLine)),
    },
    {
      title: 'Recordatorios',
      items: section(input.reminders.map(reminderLine)),
    },
    {
      title: 'Seguimientos',
      items: section(input.followups.map(followupLine)),
    },
    {
      title: 'Objetivos',
      items: section([...(input.goals ?? [])].sort(goalSort).slice(0, 5).map(goalLine)),
    },
    {
      title: 'Precios',
      items: section(
        [...(input.watches ?? [])]
          .sort((a, b) => Number(watchHit(b)) - Number(watchHit(a)))
          .slice(0, 5)
          .map(watchLine),
      ),
    },
  ];

  const lines: string[] = [greeting];
  const weather = oneLine(input.weather ?? '', 160);
  if (weather) lines.push(weather);
  let wroteSection = false;
  for (const block of blocks) {
    if (block.items.length === 0) continue;
    wroteSection = true;
    lines.push('', block.title);
    for (const item of block.items) lines.push(`- ${item}`);
  }

  if (!wroteSection) {
    lines.push('', `Hoy, ${dayLabel(input.today)}, no tienes nada apuntado.`);
  }

  return clamp(lines.join('\n'));
}

/**
 * ¿Toca enviar el briefing?
 *
 * - Antes de `hour` no: aunque falte el de ayer, un resumen a las 03:00 no es útil.
 * - Una vez al día: si ya se envió hoy (a cualquier hora), no se repite.
 * - Recuperación: si el último envío fue otro día y ya pasó la hora, se manda ahora,
 *   aunque hayan pasado horas o el daemon llevara días parado.
 * - Un último envío fechado en un día futuro (reloj corregido hacia atrás) no
 *   bloquea: cuenta como sin registro.
 */
export function briefingDue(lastMs: number | undefined, now: Date, hour = 8): boolean {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return false;

  const safeHour = Number.isFinite(hour) ? Math.min(23, Math.max(0, Math.trunc(hour))) : 8;
  // La hora del briefing es la de Nico (PA_TIMEZONE), no la del proceso.
  const today = wallClock(now);
  if (nowMs < zonedTime(today.year, today.month, today.day, safeHour)) return false;

  if (lastMs === undefined || !Number.isFinite(lastMs) || lastMs <= 0) return true;
  const last = new Date(lastMs);
  if (!Number.isFinite(last.getTime())) return false;

  // Comparar el día local, no el instante: un envío a las 07:00 de hoy ya es el de hoy.
  const sameDay = localDay(last) === localDay(now);
  if (sameDay) return false;
  // Un último envío fechado en un día FUTURO es imposible: el reloj iba adelantado
  // y luego se corrigió. Antes bloqueaba el briefing hasta que pasara esa fecha
  // (días o meses sin resumen). Se trata como "sin registro": se envía y el
  // markSent de este envío deja la fecha buena. Un adelanto de minutos dentro de
  // hoy cae en sameDay arriba y no duplica.
  return true;
}
