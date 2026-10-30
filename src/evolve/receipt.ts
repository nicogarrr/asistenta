/**
 * Receipt de verificación de un candidato de la evolución (ROADMAP, decidido por
 * Nico: «verificación con checklist + receipt antes de dar nada por listo» y
 * «spec antes de código»).
 *
 * `judge` decide si el número mejora; el receipt deja por escrito, junto al parche,
 * QUÉ se comprobó y con qué resultado, para que el PR se audite contra una prueba y
 * no contra un «está listo». Un candidato sin todas las casillas en verde no se
 * promueve: «listo» sin prueba verificable no cuenta.
 */
import { comparable, type Measurement } from './score.js';

export interface ChecklistItem {
  ok: boolean;
  label: string;
  detail: string;
}

export interface ReceiptInput {
  week: string;
  hypothesis: string;
  attempt: number;
  kernel: string;
  branch: string;
  touched: readonly string[];
  forbidden: readonly string[];
  baseline: Measurement;
  candidate: Measurement;
  verdictReason: string;
  delta: number;
  minGainPct: number;
}

/** Spec mínima: una hipótesis con contenido, no una palabra suelta. */
const MIN_SPEC_CHARS = 12;

export function verificationChecklist(i: ReceiptInput): ChecklistItem[] {
  const spec = i.hypothesis.trim();
  const c = i.candidate;
  const b = i.baseline;
  return [
    {
      ok: spec.length >= MIN_SPEC_CHARS,
      label: 'Spec antes de código',
      detail: spec ? `hipótesis: «${spec.slice(0, 200)}»` : 'sin hipótesis escrita',
    },
    {
      ok: i.touched.length > 0,
      label: 'El intento cambia algo',
      detail: `${i.touched.length} fichero(s)`,
    },
    {
      ok: i.forbidden.length === 0,
      label: 'No toca ficheros ni reglas prohibidas',
      detail: i.forbidden.length ? i.forbidden.join(', ') : 'ninguno',
    },
    {
      ok: !c.error && comparable(b, c),
      label: 'Medición válida y comparable con la base',
      detail: c.error ? `error: ${c.error}` : `${Math.round(c.durationMs / 1000)} s`,
    },
    testsItem(b, c),
    checksItem(b, c),
  ];
}

/**
 * Tests, con la misma regla que el juez: un test que pasaba en la base y ya no pasa (falla, o
 * desapareció del informe) es una regresión aunque el total de fallos no suba, y sin informe
 * por test en una de las dos mediciones el juez descarta. Antes solo se comparaba `failed`, y
 * el receipt daba ✓ a un candidato que arreglaba un test y rompía otro.
 */
function testsItem(b: Measurement, c: Measurement): ChecklistItem {
  const counts = `base ${b.passed} ok / ${b.failed} fallan → candidato ${c.passed} ok / ${c.failed} fallan`;
  if (!b.passingTests || !c.passingTests) {
    return {
      ok: false,
      label: 'Tests: ninguno que pasaba deja de pasar, y no hay más fallos que en la base',
      detail: `${counts}; sin informe por test en la base o en el candidato`,
    };
  }
  const now = new Set(c.passingTests);
  const lost = b.passingTests.filter((n) => !now.has(n));
  return {
    ok: c.failed <= b.failed && lost.length === 0,
    label: 'Tests: ninguno que pasaba deja de pasar, y no hay más fallos que en la base',
    detail: lost.length
      ? `${counts}; dejan de pasar: ${lost.slice(0, 3).join('; ')}${lost.length > 3 ? ` y ${lost.length - 3} más` : ''}`
      : counts,
  };
}

/**
 * Checks e2e, con la misma regla que el juez (#856): un check que pasaba en la base y ya no
 * pasa (falla, o la sonda dejó de imprimirlo) es una regresión aunque el total de fallos no
 * suba; sin nombres, menos checks que pasan lo es. Antes solo se comparaba `checksFailed`, y
 * el receipt daba ✓ a un candidato que el juez había descartado por regresión en las sondas.
 */
function checksItem(b: Measurement, c: Measurement): ChecklistItem {
  const now = new Set(c.passingChecks ?? []);
  const lost = b.passingChecks && c.passingChecks ? b.passingChecks.filter((n) => !now.has(n)) : [];
  const counts = `base ${b.checks} ok / ${b.checksFailed} fallan → candidato ${c.checks} ok / ${c.checksFailed} fallan`;
  return {
    ok: c.checksFailed <= b.checksFailed && c.checks >= b.checks && lost.length === 0,
    label: 'Checks e2e: ninguno que pasaba deja de pasar, y no hay más fallos que en la base',
    detail: lost.length
      ? `${counts}; dejan de pasar: ${lost.slice(0, 3).join('; ')}${lost.length > 3 ? ` y ${lost.length - 3} más` : ''}`
      : counts,
  };
}

export function checklistPasses(items: readonly ChecklistItem[]): boolean {
  return items.every((it) => it.ok);
}

/** El receipt en Markdown, legible en el PR y en el disco. */
export function renderReceipt(i: ReceiptInput, items: readonly ChecklistItem[]): string {
  const lines = [
    `# Receipt de verificación — evolución ${i.week}`,
    '',
    `- Hipótesis (spec): ${i.hypothesis.trim() || '(vacía)'}`,
    `- Intento: ${i.attempt}`,
    `- Kernel: ${i.kernel}`,
    `- Rama candidata: ${i.branch}`,
    `- Mejora: ${i.delta >= 0 ? '+' : ''}${i.delta} (mínimo exigido ${i.minGainPct} %)`,
    `- Veredicto: ${i.verdictReason}`,
    '',
    '## Checklist',
    '',
    ...items.map((it) => `- [${it.ok ? 'x' : ' '}] ${it.label}: ${it.detail}`),
    '',
    '## Ficheros tocados',
    '',
    ...(i.touched.length ? i.touched.map((f) => `- ${f}`) : ['- (ninguno)']),
    '',
    checklistPasses(items)
      ? 'Resultado: checklist completa. Va como PR con auditoría; no se ha mergeado nada.'
      : 'Resultado: checklist INCOMPLETA. No se promueve.',
    '',
  ];
  return lines.join('\n');
}
