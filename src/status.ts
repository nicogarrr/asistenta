import { REACTION_LOG_MSG, REACTION_NEGATIVE_LOG_MSG } from './channels/telegram-reacciones.js';
import { type ProjectContext, projectFolderName } from './project-context.js';
/**
 * Datos para /estado: que Nico vea desde Telegram si algo falla, sin abrir el PC.
 *
 * Solo lee lo que Asistenta ya escribe de sí misma (su log diario) y qué herramientas
 * externas tiene. Del log salen solo los mensajes (`msg`), nunca los campos, que es
 * donde podría colarse algo sensible, y se recortan.
 */

export interface LogSummary {
  warns: number;
  errors: number;
  /** Últimos mensajes de error distintos, del más reciente al más antiguo. */
  recentErrors: string[];
  /** Reacciones del dueño a respuestas del bot hoy: 👍/❤️… y 👎/🤔… (el 👎 pide revisarla). */
  reactions?: { positive: number; negative: number };
}

/** Resume un fichero JSONL de log. Las líneas rotas se ignoran: un log a medias no es un fallo. */
export function summarizeLog(jsonl: string, maxRecent = 3): LogSummary {
  let warns = 0;
  let errors = 0;
  let positive = 0;
  let negative = 0;
  const seen: string[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let rec: { level?: unknown; msg?: unknown };
    try {
      rec = JSON.parse(line) as typeof rec;
    } catch {
      continue;
    }
    if (typeof rec.msg === 'string' && rec.level === 'info') {
      if (rec.msg.endsWith(REACTION_NEGATIVE_LOG_MSG)) negative++;
      else if (rec.msg.endsWith(REACTION_LOG_MSG)) positive++;
    }
    if (rec.level === 'warn') warns++;
    else if (rec.level === 'error') {
      errors++;
      const msg = typeof rec.msg === 'string' ? rec.msg.slice(0, 120) : '';
      if (msg) {
        const i = seen.indexOf(msg);
        if (i >= 0) seen.splice(i, 1);
        seen.push(msg);
      }
    }
  }
  const summary: LogSummary = { warns, errors, recentErrors: seen.slice(-maxRecent).reverse() };
  if (positive || negative) summary.reactions = { positive, negative };
  return summary;
}

export function formatDuration(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'menos de 1 min';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

export interface StatusInfo {
  version: string;
  node: string;
  uptimeMs: number;
  tools: { name: string; ok: boolean; note?: string }[];
  log: LogSummary | null;
  pageWatches: number;
  /** Recordatorios puntuales que no pude entregar y descarté (texto ya legible). */
  droppedReminders?: string[];
  /** Solo en el chat privado del dueño: proyecto y modelo de esta conversación. */
  conversation?: string[];
  /** «Grupos donde estoy»: una línea por grupo (gruposEstado); solo al dueño en privado. */
  grupos?: string[];
  /** Cuánto tarda en contestar (daemon/latency.ts). */
  latency?: string;
}

/**
 * Líneas de «Esta conversación» en /estado: la carpeta de /proyecto (y qué
 * fichero cargo) y el modelo de /modelo. Solo para el dueño en privado: la
 * ruta de una carpeta local no se enseña en un grupo.
 */
/** Sin carpeta de proyecto: cómo ligar una en palabras (la ruta pegada la lee `projectAnswer`). */
export const PROJECT_NONE_LINE =
  'Proyecto: ninguno (si quieres que tenga en cuenta una carpeta, pégame su ruta).';

export function conversationStatus(c: {
  projectDir?: string;
  project?: ProjectContext | null;
  model: string;
  primaryModel: string;
  /** Datos del resumen de esta conversación marcados «SIN VERIFICAR:» (solo el número). */
  sinVerificar?: number;
}): string[] {
  const project = !c.projectDir
    ? PROJECT_NONE_LINE
    : c.project?.ok
      ? `Proyecto: carpeta «${projectFolderName(c.project.dir)}» (tengo en cuenta ${c.project.name}).`
      : `Proyecto: carpeta «${projectFolderName(c.projectDir)}», pero ahora no puedo leer nada: ${c.project?.ok === false ? c.project.reason : 'no hay fichero'}.`;
  const model = `Modelo: ${c.model}${c.model === c.primaryModel ? ' (principal)' : ' (el que elegiste)'}.`;
  const n = c.sinVerificar ?? 0;
  if (n <= 0) return [project, model];
  const sv =
    n === 1
      ? '⚠️ 1 dato del resumen va marcado SIN VERIFICAR: no lo des por hecho sin comprobarlo.'
      : `⚠️ ${n} datos del resumen van marcados SIN VERIFICAR: no los des por hechos sin comprobarlos.`;
  return [project, model, sv];
}

/** Grupos que enseña /estado como mucho (el resto, «y N más»). */
export const ESTADO_GRUPOS_MAX = 8;

function haceDias(ms: number): string {
  const d = Math.floor(ms / 86_400_000);
  if (d <= 0) return 'hoy';
  if (d === 1) return 'ayer';
  return `hace ${d} días`;
}

/**
 * «Grupos donde estoy» de /estado: el nombre de cada grupo de Telegram en que me han
 * escrito (chat-titulos.ts) y cuándo fue la última vez, del más reciente al más viejo.
 * Uno que ya no se oye en meses puede ser un grupo del que me sacaron: se ve en la fecha.
 */
export function gruposEstado(
  grupos: ReadonlyArray<{ titulo: string; visto: number }>,
  now: number = Date.now(),
): string[] {
  if (!grupos.length) return [];
  const lines = grupos
    .slice(0, ESTADO_GRUPOS_MAX)
    .map((g) => `«${g.titulo}» (último mensaje ${haceDias(now - g.visto)})`);
  if (grupos.length > ESTADO_GRUPOS_MAX) lines.push(`…y ${grupos.length - ESTADO_GRUPOS_MAX} más`);
  return lines;
}

export function formatStatus(s: StatusInfo): string {
  const lines = [
    `Asistenta ${s.version} (Node ${s.node}), encendida desde hace ${formatDuration(s.uptimeMs)}.`,
    '',
    ...s.tools.map((t) => `${t.ok ? 'OK' : 'FALTA'} ${t.name}${t.note ? ` - ${t.note}` : ''}`),
    '',
  ];
  if (!s.log) {
    lines.push('Log de hoy: no he podido leerlo.');
  } else if (s.log.errors === 0 && s.log.warns === 0) {
    lines.push('Log de hoy: sin avisos ni errores.');
  } else {
    lines.push(
      `Log de hoy: ${s.log.errors} ${s.log.errors === 1 ? 'error' : 'errores'}, ${s.log.warns} ${s.log.warns === 1 ? 'aviso' : 'avisos'}.`,
    );
    for (const e of s.log.recentErrors) lines.push(`- ${e}`);
  }
  if (s.log?.reactions) {
    const r = s.log.reactions;
    lines.push(
      `Tus reacciones de hoy: 👍 ${r.positive} · 👎 ${r.negative}${r.negative ? ' (las revisé)' : ''}.`,
    );
  }
  if (s.latency) lines.push(s.latency);
  lines.push(`Páginas vigiladas: ${s.pageWatches}.`);
  for (const d of s.droppedReminders ?? []) lines.push(`No pude avisarte de: ${d}`);
  if (s.grupos?.length) {
    lines.push('', 'Grupos donde estoy:');
    for (const l of s.grupos) lines.push(`- ${l}`);
  }
  if (s.conversation?.length) {
    lines.push('', 'Esta conversación:');
    for (const l of s.conversation) lines.push(`- ${l}`);
  }
  return lines.join('\n');
}
