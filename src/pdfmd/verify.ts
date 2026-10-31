/**
 * Comprobar tablas de un texto sacado de un PDF y, si las hizo un modelo, reintentar.
 * Idea de pdf2md (https://github.com/Ntizar/pdf2md, licencia MIT): verificar sin IA y,
 * si falla, devolver el informe al modelo como pista; tras unos intentos se queda el
 * resultado marcado como «sin comprobar» en vez de perderlo.
 */
import { describeIssues, type TableReport, verifyTables } from './tables.js';

export const MAX_TRIES = 3;

export interface VerifiedText {
  text: string;
  report: TableReport;
  tries: number;
  verified: boolean;
}

/**
 * `produce(feedback)` genera el Markdown; en el primer intento `feedback` es undefined y
 * en los siguientes lleva el informe de lo que no cuadró. Máximo `maxTries` intentos
 * (entre 1 y 3). Si nunca cuadra, devuelve el intento con menos problemas.
 */
export async function verifyWithRetry(
  produce: (feedback?: string) => Promise<string>,
  maxTries = MAX_TRIES,
): Promise<VerifiedText> {
  const limit = Math.max(1, Math.min(MAX_TRIES, Math.floor(maxTries)));
  let best: VerifiedText | undefined;
  let feedback: string | undefined;
  for (let tries = 1; tries <= limit; tries++) {
    const text = await produce(feedback);
    const report = verifyTables(text);
    const cur = { text, report, tries, verified: report.ok };
    if (report.ok) return cur;
    if (!best || report.issues.length < best.report.issues.length) best = cur;
    feedback = `Las tablas no cuadran. Revisa el original y corrige solo esto:\n${describeIssues(report)}`;
  }
  return { ...(best as VerifiedText), tries: limit, verified: false };
}

export interface PageIssue {
  page: number;
  table: number;
  problem: string;
}

const PAGE_MARK = /^--- página (\d+) ---$/m;

/** Parte el texto del OCR por sus marcas «--- página N ---» (sin marcas: página 1). */
export function splitPages(text: string): { page: number; text: string }[] {
  if (!PAGE_MARK.test(text)) return [{ page: 1, text }];
  const parts = text.split(/^--- página (\d+) ---$/m);
  const out: { page: number; text: string }[] = [];
  for (let i = 1; i < parts.length; i += 2)
    out.push({ page: Number(parts[i]), text: parts[i + 1] ?? '' });
  return out;
}

/** Revisa las tablas página a página. */
export function checkPages(text: string): { tables: number; issues: PageIssue[] } {
  let tables = 0;
  const issues: PageIssue[] = [];
  for (const p of splitPages(text)) {
    const r = verifyTables(p.text);
    tables += r.tables;
    for (const x of r.issues) issues.push({ page: p.page, table: x.table, problem: x.problem });
  }
  return { tables, issues };
}

/** Aviso corto en castellano para el final de la respuesta; vacío si todo cuadra. */
export function tableNote(issues: PageIssue[], multiPage: boolean): string {
  if (issues.length === 0) return '';
  const shown = issues.slice(0, 5).map((x) => {
    const where = multiPage ? `página ${x.page}, tabla ${x.table}` : `tabla ${x.table}`;
    return `- ${where}: ${x.problem}.`;
  });
  const more = issues.length > 5 ? [`- y ${issues.length - 5} más.`] : [];
  const n = new Set(issues.map((x) => `${x.page}/${x.table}`)).size;
  const head =
    n === 1
      ? 'Ojo: no he podido comprobar una tabla; revísala con el PDF original:'
      : `Ojo: no he podido comprobar ${n} tablas; revísalas con el PDF original:`;
  return [head, ...shown, ...more].join('\n');
}
