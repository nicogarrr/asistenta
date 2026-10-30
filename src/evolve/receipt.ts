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
    {
      ok: c.failed <= b.failed,
      label: 'Tests: no hay más fallos que en la base',
      detail: `base ${b.passed} ok / ${b.failed} fallan → candidato ${c.passed} ok / ${c.failed} fallan`,
    },
    {
      ok: c.checksFailed <= b.checksFailed,
      label: 'Checks e2e: no hay más fallos que en la base',
      detail: `base ${b.checks} ok / ${b.checksFailed} fallan → candidato ${c.checks} ok / ${c.checksFailed} fallan`,
    },
  ];
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
