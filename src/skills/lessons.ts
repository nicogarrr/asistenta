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

import { sliceSafe } from '../text.js';
import { plainInline } from '../utils.js';
import { type SkillStore, slugify } from './store.js';
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

/** Look-and-bookkeeping tools: one of these working after a failure is not a way around it. */
const TRIVIAL_FIXES = new Set(['read', 'list', 'memory', 'skills', 'done']);

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
      if (!worked.ok || key(worked) === key(failed) || TRIVIAL_FIXES.has(worked.tool)) continue;
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
      const draft = lessonDraft(r, day);
      // A lesson seen again only gains the recurrence note: whatever the owner edited in
      // its steps, description or whenToUse stays as it is.
      const existing = store.read(slugify(draft.name));
      ids.push(
        store.save(
          existing
            ? {
                name: existing.name,
                description: existing.description,
                category: existing.category,
                whenToUse: existing.whenToUse,
                steps: existing.steps,
                notes: draft.notes,
              }
            : draft,
        ),
      );
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

export const SKILLS_INDEX_MAX = 20;
export const SKILLS_INDEX_LINE_CHARS = 110;

/**
 * Level-zero index of the skills for the context note: one short line each, newest
 * first, capped. Full steps stay behind `skills read`, so the model pays about
 * 25 tokens per skill instead of the whole recipe, and still knows what exists.
 */
export function skillsIndex(
  skills: readonly { id: string; whenToUse: string; description: string; updatedAt: number }[],
  max = SKILLS_INDEX_MAX,
): string {
  const lines = [...skills]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, max)
    .map((s) => {
      // Plain one-line text: no <tags> or backticks, so a skill cannot close the <skills> block
      // or pose as markup in the context note.
      const hint = plainInline(s.whenToUse || s.description)
        .replace(/\s+/g, ' ')
        .trim();
      const clipped =
        hint.length > SKILLS_INDEX_LINE_CHARS
          ? `${sliceSafe(hint, SKILLS_INDEX_LINE_CHARS - 1)}…`
          : hint;
      return `- ${s.id}: ${clipped}`;
    });
  if (!lines.length) return '';
  const more = skills.length > max ? `\n(+${skills.length - max} más: skills list)` : '';
  return `<skills>\n${lines.join('\n')}${more}\n</skills>`;
}
