import { existsSync, readFileSync } from 'node:fs';
import { auditLedgerPath, type CallAuditLine, type CallVerdict, verifyCallAudit } from './calls.js';

/**
 * Consulta del registro durable de llamadas.
 *
 * El ledger (ver `calls.ts`) está pensado para responder "¿quién aprobó esta
 * llamada exacta, con qué argumentos y cuándo terminó?". Estas funciones lo
 * leen sin exponer los argumentos: solo devuelven las líneas ya hasheadas.
 *
 * La integridad se comprueba al leer: una línea editada, borrada o reordenada
 * rompe la cadena y `readCallAudit` falla con la línea exacta. Consultar un
 * registro manipulado como si fuera cierto sería peor que no poder consultarlo.
 */

export interface CallAuditSummary {
  total: number;
  allows: number;
  denies: number;
  /** Líneas con `isError: true`, sea cual sea el veredicto del gate. */
  errors: number;
  byTool: Record<string, number>;
  /** Timestamp ISO de la primera línea, si hay alguna. */
  first?: string;
  /** Timestamp ISO de la última línea, si hay alguna. */
  last?: string;
}

export interface CallAuditFilter {
  tool?: string;
  verdict?: CallVerdict;
  /** Desde este instante, inclusive. Acepta ISO, epoch ms o Date. */
  since?: string | number | Date;
  callId?: string;
}

function sinceMs(since: CallAuditFilter['since']): number | null {
  if (since === undefined) return null;
  const ms = since instanceof Date ? since.getTime() : new Date(since).getTime();
  if (!Number.isFinite(ms)) {
    throw new Error(`since inválido: ${String(since)}`);
  }
  return ms;
}

/**
 * Lee todas las líneas del ledger, en orden. Un fichero inexistente es una
 * auditoría vacía, no un error. Un fichero corrupto sí es un error: se lanza
 * con el número de línea para que la rotura no pase inadvertida.
 */
export function readCallAudit(file: string = auditLedgerPath()): CallAuditLine[] {
  if (!existsSync(file)) return [];
  const integrity = verifyCallAudit(file);
  if (!integrity.ok) {
    throw new Error(
      `auditoría de llamadas corrupta en la línea ${integrity.brokenAt ?? '?'}: ` +
        `${integrity.reason ?? 'cadena rota'}`,
    );
  }
  const raw = readFileSync(file, 'utf8');
  const lines: CallAuditLine[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    lines.push(JSON.parse(line) as CallAuditLine);
  }
  return lines;
}

/** Resumen agregado: veredictos, errores, reparto por herramienta y extremos. */
export function summarizeCallAudit(lines: readonly CallAuditLine[]): CallAuditSummary {
  const byTool: Record<string, number> = {};
  let allows = 0;
  let denies = 0;
  let errors = 0;
  for (const line of lines) {
    if (line.verdict === 'allow') allows += 1;
    else if (line.verdict === 'deny') denies += 1;
    if (line.isError === true) errors += 1;
    byTool[line.tool] = (byTool[line.tool] ?? 0) + 1;
  }
  const first = lines[0]?.ts;
  const last = lines[lines.length - 1]?.ts;
  return {
    total: lines.length,
    allows,
    denies,
    errors,
    byTool,
    ...(first === undefined ? {} : { first }),
    ...(last === undefined ? {} : { last }),
  };
}

/** Filtra en memoria, conservando el orden del ledger. */
export function filterCallAudit(
  lines: readonly CallAuditLine[],
  filter: CallAuditFilter,
): CallAuditLine[] {
  const since = sinceMs(filter.since);
  return lines.filter((line) => {
    if (filter.tool !== undefined && line.tool !== filter.tool) return false;
    if (filter.verdict !== undefined && line.verdict !== filter.verdict) return false;
    if (filter.callId !== undefined && line.callId !== filter.callId) return false;
    if (since !== null) {
      const ts = Date.parse(line.ts);
      if (!Number.isFinite(ts) || ts < since) return false;
    }
    return true;
  });
}
