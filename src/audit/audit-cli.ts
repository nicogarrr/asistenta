/**
 * `pa auditoria`: consulta de solo lectura del registro durable de llamadas a
 * herramientas (`<estado>/audit/calls.jsonl`). Usa `audit/query.ts`, que antes no
 * llamaba nadie: el registro se escribía y verificaba, pero no había forma de leerlo.
 *
 *   pa auditoria [--tool <nombre>] [--verdict allow|deny] [--since 24h|7d|<ISO>] [--last N] [--json]
 */

import type { CallAuditFilter } from './query.js';
import { filterCallAudit, readCallAudit, summarizeCallAudit } from './query.js';

const USAGE =
  'uso: pa auditoria [--tool <nombre>] [--verdict allow|deny] [--since 24h|7d|<ISO>] [--last N] [--json]\n';

/** `24h`, `7d`, `30m` relativos a `now`; cualquier otra cosa se pasa tal cual (ISO). */
export function parseSince(value: string, now = Date.now()): string {
  const m = /^(\d+)\s*([mhd])$/i.exec(value.trim());
  if (!m) return value;
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]?.toLowerCase() as 'm' | 'h' | 'd'];
  return new Date(now - Number(m[1]) * unit).toISOString();
}

interface Out {
  write(text: string): unknown;
}

export function auditCommand(
  args: string[],
  opts: { file?: string; out?: Out; err?: Out; now?: number } = {},
): number {
  const out = opts.out ?? process.stdout;
  const err = opts.err ?? process.stderr;
  const filter: CallAuditFilter = {};
  let last = 20;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === '--json') {
      json = true;
      continue;
    }
    if (flag === '--help' || flag === '-h') {
      out.write(USAGE);
      return 0;
    }
    if (value === undefined || !['--tool', '--verdict', '--since', '--last'].includes(flag ?? '')) {
      err.write(USAGE);
      return 2;
    }
    i++;
    if (flag === '--tool') filter.tool = value;
    else if (flag === '--verdict') {
      if (value !== 'allow' && value !== 'deny') {
        err.write(USAGE);
        return 2;
      }
      filter.verdict = value;
    } else if (flag === '--since') filter.since = parseSince(value, opts.now);
    else {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) {
        err.write(USAGE);
        return 2;
      }
      last = n;
    }
  }
  let lines: ReturnType<typeof readCallAudit>;
  try {
    lines = filterCallAudit(readCallAudit(opts.file), filter);
  } catch (e) {
    err.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  const summary = summarizeCallAudit(lines);
  const recent = last === 0 ? [] : lines.slice(-last);
  if (json) {
    out.write(`${JSON.stringify({ summary, recent }, null, 2)}\n`);
    return 0;
  }
  if (summary.total === 0) {
    out.write('No hay llamadas registradas con ese filtro.\n');
    return 0;
  }
  const tools = Object.entries(summary.byTool)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${t} ${n}`)
    .join(', ');
  out.write(
    `${summary.total} llamadas: ${summary.allows} permitidas, ${summary.denies} denegadas, ${summary.errors} con error.\n` +
      `Por herramienta: ${tools}\n`,
  );
  if (recent.length) {
    out.write(`Últimas ${recent.length}:\n`);
    for (const l of recent) {
      const when = new Date(l.ts).toLocaleString('es-ES');
      const flags = `${l.verdict === 'deny' ? ' DENEGADA' : ''}${l.isError ? ' ERROR' : ''}`;
      out.write(`- ${when} ${l.tool}${flags}${l.reason ? ` (${l.reason})` : ''}\n`);
    }
  }
  return 0;
}
