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
}

/** Resume un fichero JSONL de log. Las líneas rotas se ignoran: un log a medias no es un fallo. */
export function summarizeLog(jsonl: string, maxRecent = 3): LogSummary {
  let warns = 0;
  let errors = 0;
  const seen: string[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let rec: { level?: unknown; msg?: unknown };
    try {
      rec = JSON.parse(line) as typeof rec;
    } catch {
      continue;
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
  return { warns, errors, recentErrors: seen.slice(-maxRecent).reverse() };
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
    lines.push(`Log de hoy: ${s.log.errors} errores, ${s.log.warns} avisos.`);
    for (const e of s.log.recentErrors) lines.push(`- ${e}`);
  }
  lines.push(`Páginas vigiladas: ${s.pageWatches}.`);
  return lines.join('\n');
}
