/**
 * Lessons from problems: when a tool failed and the run then got what it wanted
 * another way, remember the way that worked.
 *
 * Deliberately narrow. The input is the structured trail of a run (tool name,
 * action label, ok or not), never the text a tool returned: that text can come from
 * a web page or an email, and a lesson that is written from it is a way to plant
 * instructions the agent will follow in every later run. What is learned is only
 * "tool A (action x) failed, tool B (action y) worked right after", which cannot
 * carry anyone's words. Lessons are saved without asking (the owner wants the
 * agent as autonomous as possible) into the `lecciones` category, where they can be
 * read, edited or deleted like any skill; `lintSkill` flags the ones that look off.
 */
import type { SkillStore } from './store.js';
import type { SkillDraft } from './types.js';

export const LESSON_CATEGORY = 'lecciones';

/** How many later calls may separate a failure from the call that "fixed" it. */
export const RECOVERY_WINDOW = 3;

export interface RunStep {
  tool: string;
  /** The `action` argument when the tool has one and it is a plain label, else ''. */
  action: string;
  ok: boolean;
}

export interface Recovery {
  failed: RunStep;
  worked: RunStep;
}

const LABEL = /^[a-z][a-z0-9_-]{0,29}$/;

/** Only a short identifier-like label may travel from tool arguments into a lesson. */
export function actionLabel(args: unknown): string {
  if (args === null || typeof args !== 'object') return '';
  const raw = (args as Record<string, unknown>).action;
  return typeof raw === 'string' && LABEL.test(raw) ? raw : '';
}

const key = (s: RunStep): string => (s.action ? `${s.tool}:${s.action}` : s.tool);

/**
 * Failures followed within RECOVERY_WINDOW calls by a success of a DIFFERENT
 * tool/action. The same call succeeding on retry is a flaky tool, not a lesson, and
 * `done` or bookkeeping tools never count as the fix.
 */
export function findRecoveries(steps: readonly RunStep[]): Recovery[] {
  const out = new Map<string, Recovery>();
  steps.forEach((failed, i) => {
    if (failed.ok) return;
    for (const worked of steps.slice(i + 1, i + 1 + RECOVERY_WINDOW)) {
      if (!worked.ok || key(worked) === key(failed) || worked.tool === 'done') continue;
      out.set(`${key(failed)}>${key(worked)}`, { failed, worked });
      break;
    }
  });
  return [...out.values()];
}

export function lessonDraft(r: Recovery, day: string): SkillDraft {
  const from = key(r.failed);
  const to = key(r.worked);
  return {
    name: `Si ${from} falla, probar ${to}`,
    description: `Cuando ${from} falla, ${to} ha funcionado.`,
    category: LESSON_CATEGORY,
    whenToUse: `Cuando la herramienta ${from} devuelve un error.`,
    steps: [
      `Si ${from} falla, prueba ${to}.`,
      'Comprueba el resultado antes de dar la tarea por hecha.',
    ],
    notes: [`Aprendida sola; vista de nuevo el ${day}.`],
  };
}

/** Save what this run learned. Returns the ids written. Never throws: learning is a bonus. */
export function recordLessons(store: SkillStore, steps: readonly RunStep[], day: string): string[] {
  const ids: string[] = [];
  for (const r of findRecoveries(steps)) {
    try {
      ids.push(store.save(lessonDraft(r, day)));
    } catch {
      // A lesson that cannot be written is not worth failing the user's task.
    }
  }
  return ids;
}

export const SKILL_BODY_WARN_CHARS = 4000;

/** Advisory warnings for a skill, in Spanish. Never blocks a write. */
export function lintSkill(s: { steps: string[]; notes: string[]; whenToUse: string }): string[] {
  const warnings: string[] = [];
  const body = [...s.steps, ...s.notes].join('\n');
  if (body.length > SKILL_BODY_WARN_CHARS) {
    warnings.push(`cuerpo largo (${body.length} caracteres): se carga entero en contexto`);
  }
  if ((body.match(/#\d+|\b\d{4}-\d{2}-\d{2}\b/g) ?? []).length > 6) {
    warnings.push(
      'parece un registro de incidentes (muchas fechas o #números): deja solo la regla',
    );
  }
  if (!s.whenToUse.trim()) warnings.push('sin whenToUse: nadie sabrá cuándo aplicarla');
  return warnings;
}
