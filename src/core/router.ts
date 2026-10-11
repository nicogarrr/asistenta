/**
 * Request-level router (levels 1-4): local, deterministic, zero-cost.
 *
 * One classification per user request, before any model call. Today there is a
 * single free model, so the level drives the iteration budget (how much work
 * the task may spend) and is audit-logged; when more free models exist, the
 * same classification is the extension point for picking the model per level.
 *
 * Design rules (Nico, 11-oct-2026): no LLM for the classification itself
 * (deciding the level must not spend model quota), deterministic, every
 * classification logged, and the user can force a level with a prefix
 * ("n1: ..." .. "n4: ..." or "nivel 1: ...").
 */
export type RequestLevel = 1 | 2 | 3 | 4;

export interface RequestClassification {
  level: RequestLevel;
  /** Why this level was chosen; logged verbatim for auditability. */
  reasons: string[];
  /** True when the user forced the level with a prefix. */
  override: boolean;
}

/** Multi-step build/change verbs and phrases (Spanish + English), level 4. */
const LEVEL4 = [
  /\bimplementa\b/,
  /\bimplementar\b/,
  /\brefactor/i,
  /\bmigra\b/,
  /\bmigrar\b/,
  /\bdespliega\b/,
  /\bdesplegar\b/,
  /\bdeploy\b/i,
  /\bcrea(?:r)? una (?:app|web|herramienta|skill)\b/,
  /\bconstru/,
  /\barquitectura\b/i,
  /\bdise[ñn]a(?:r)? (?:el|la|un|una) (?:sistema|m[oó]dulo)/i,
  /\bbuild\b/i,
  /\bfull[\s-]?stack/i,
  /\bde punta a punta\b/,
  /\bend[\s-]?to[\s-]?end\b/i,
];
/** Research/compare work, level 3-4 depending on breadth. */
const LEVEL3 = [
  /\binvestiga\b/,
  /\banaliza\b/,
  /\bcompara\b/,
  /\baudita\b/,
  /\brevisa\b/,
  /\bdiagnostica\b/,
  /\barregla\b/,
  /\bfix\b/i,
  /\bcorrige\b/,
  /\bintegra\b/,
  /\bactualiza\b/,
  /\ba[ñn]ade\b/,
  /\bprograma\b/,
  /\bconfigura\b/,
];
/** Single simple actions, level 2. */
const LEVEL2 = [
  /\bbusca\b/,
  /\benvia\b/,
  /\bmanda\b/,
  /\blee\b/,
  /\bresume\b/,
  /\btraduce\b/,
  /\brecordatorio\b/,
  /\brecuerda\b/,
  /\babre\b/,
  /\bdescarga\b/,
  /\blista\b/,
  /\bborra\b/,
  /\belimina\b/,
  /\bcancela\b/,
  /\bapaga\b/,
  /\benciende\b/,
];
/** Direct-answer questions and chatter, level 1. */
const LEVEL1 = [
  /^\s*(hola|buenas|hey|gracias|ok|vale|si|no)\b/i,
  /^(qu[eé]|cu[aá]l|cu[aá]ndo|d[oó]nde|qui[eé]n|cu[aá]nto)\b.*\??\s*$/i,
];

const OVERRIDE = /^\s*(?:n([1-4])|nivel\s+([1-4]))\s*[:.-]\s*/i;

/**
 * Classify one user request. Pure: same text in, same level out, no I/O.
 *
 * Precedence: explicit user override > multi-step build signals (4) >
 * research/change signals (3) > single action (2) > short direct question (1).
 * Long, multi-sentence requests with several action verbs climb one level:
 * breadth is the real cost driver, not any single keyword.
 */
export function classifyRequest(text: string): RequestClassification {
  const reasons: string[] = [];
  const override = OVERRIDE.exec(text);
  if (override) {
    const level = Number(override[1] ?? override[2]) as RequestLevel;
    return { level, reasons: [`prefijo explicito del usuario (nivel ${level})`], override: true };
  }
  const body = text.trim();
  const hits4 = LEVEL4.filter((re) => re.test(body)).map((re) => re.source);
  if (hits4.length) {
    reasons.push(`senal de construccion multi-paso: ${hits4[0]}`);
    return { level: 4, reasons, override: false };
  }
  const hits3 = LEVEL3.filter((re) => re.test(body)).map((re) => re.source);
  const hits2 = LEVEL2.filter((re) => re.test(body)).map((re) => re.source);
  const sentences = body.split(/[.!?\n]+/).filter((s) => s.trim().length > 0).length;
  const actions = hits3.length + hits2.length;
  if (hits3.length) {
    reasons.push(`tarea de investigacion/cambio: ${hits3[0]}`);
    if (actions >= 2 || sentences >= 3) {
      reasons.push('varias acciones o frases: sube a 4 por amplitud');
      return { level: 4, reasons, override: false };
    }
    return { level: 3, reasons, override: false };
  }
  if (hits2.length) {
    reasons.push(`accion simple: ${hits2[0]}`);
    if (actions >= 2 && sentences >= 2) {
      reasons.push('varias acciones encadenadas: sube a 3');
      return { level: 3, reasons, override: false };
    }
    return { level: 2, reasons, override: false };
  }
  if (body.length <= 120 && LEVEL1.some((re) => re.test(body))) {
    reasons.push('pregunta directa o charla corta');
    return { level: 1, reasons, override: false };
  }
  reasons.push('sin senales de mayor nivel: estandar');
  return { level: 3, reasons, override: false };
}

/**
 * Iteration budget per level, scaled from the configured base. Levels only
 * shrink the ceiling, never grow it past base: a misclassified small task
 * costs a retry, a misclassified big one must never lose headroom it had.
 */
export function iterationBudgetFor(level: RequestLevel, base: number): number {
  if (!Number.isInteger(base) || base < 0) {
    throw new RangeError(`base budget must be a non-negative integer, got ${base}`);
  }
  switch (level) {
    case 1:
      return Math.min(base, 10);
    case 2:
      return Math.min(base, 25);
    default:
      return base;
  }
}
