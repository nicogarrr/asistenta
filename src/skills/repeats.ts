/**
 * «Esto ya lo he hecho varias veces»: cuando la misma receta se repite, se le
 * ofrece al dueño guardarla como habilidad en una sola línea. Él dice que sí una
 * vez (skills action=accept) y queda guardada; si no dice nada, no se vuelve a
 * ofrecer la misma.
 *
 * Igual que las lecciones (lessons.ts), solo mira el rastro estructurado del
 * turno (herramienta, acción, ok), nunca el texto de una página o un correo: una
 * oferta no puede llevar palabras de nadie. La receta guardada nace con
 * `outward: true` (ante la duda, pide permiso antes de actuar hacia fuera).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RunStep } from './lessons.js';
import type { Skill, SkillDraft } from './types.js';

/** Veces que tiene que repetirse la misma receta antes de ofrecerla. */
export const REPEAT_THRESHOLD = 3;
/** Herramientas/acciones distintas mínimas para que sea una receta. */
export const MIN_DISTINCT_STEPS = 3;
/** Recetas vistas que se recuerdan; las más antiguas se olvidan. */
export const MAX_TRACKED = 200;

/** Mirar y apuntar no es una receta: no cuentan. */
const IGNORED = new Set(['read', 'list', 'memory', 'skills', 'done', 'ask', 'cargar_herramienta']);

const LABEL = /^[a-z][a-z0-9_-]{0,29}$/;

interface Entry {
  count: number;
  offered: boolean;
  seen: number;
}

interface State {
  entries: Record<string, Entry>;
  pending: { key: string; draft: SkillDraft } | null;
}

export interface RepeatOffer {
  key: string;
  draft: SkillDraft;
  /** Una línea para el final de la respuesta. */
  line: string;
}

/** La receta del turno: pasos que funcionaron, sin repetir, en orden. */
export function recipeOf(steps: readonly RunStep[]): string[] {
  const out: string[] = [];
  for (const step of steps) {
    if (!step.ok || IGNORED.has(step.tool) || !LABEL.test(step.tool)) continue;
    const action = LABEL.test(step.action) ? step.action : '';
    const key = action ? `${step.tool}: ${action}` : step.tool;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

function sameRecipe(skill: Skill, recipe: readonly string[]): boolean {
  const steps = new Set(skill.steps);
  return recipe.every((step) => steps.has(step));
}

export class RepeatTracker {
  readonly #file: string;
  #state: State;

  constructor(file: string) {
    this.#file = file;
    this.#state = this.#load();
  }

  /** Oferta pendiente de un sí, si la hay. */
  get pending(): { key: string; draft: SkillDraft } | null {
    return this.#state.pending;
  }

  /**
   * Apunta la receta de un turno. Devuelve una oferta la vez que llega a
   * REPEAT_THRESHOLD, si no hay ya una habilidad con esos pasos y no se ofreció.
   */
  observe(
    steps: readonly RunStep[],
    existing: readonly Skill[],
    now = Date.now(),
  ): RepeatOffer | null {
    const recipe = recipeOf(steps);
    if (recipe.length < MIN_DISTINCT_STEPS) return null;
    const key = [...recipe].sort().join(' | ');
    const entry = this.#state.entries[key] ?? { count: 0, offered: false, seen: now };
    entry.count += 1;
    entry.seen = now;
    this.#state.entries[key] = entry;
    let offer: RepeatOffer | null = null;
    if (
      entry.count >= REPEAT_THRESHOLD &&
      !entry.offered &&
      !existing.some((skill) => sameRecipe(skill, recipe))
    ) {
      entry.offered = true;
      const tools = [...new Set(recipe.map((step) => step.split(':')[0]))];
      const draft: SkillDraft = {
        name: `Receta ${tools.join(' + ')}`,
        description: `Lo que hago a menudo con ${tools.join(', ')}`,
        category: 'repetidas',
        whenToUse: `Cuando me pidan otra vez lo que hice con ${tools.join(', ')}.`,
        steps: recipe,
        notes: [`Ofrecida tras repetirse ${entry.count} veces.`],
        outward: true,
      };
      this.#state.pending = { key, draft };
      offer = {
        key,
        draft,
        line: `🔁 Esto ya lo he hecho ${entry.count} veces (${tools.join(', ')}). ¿Lo guardo como habilidad? Dime «sí, guárdala».`,
      };
    }
    this.#prune();
    this.#save();
    return offer;
  }

  /** El dueño dijo que sí: devuelve la receta pendiente y la quita. */
  takePending(): SkillDraft | null {
    const pending = this.#state.pending;
    if (!pending) return null;
    this.#state.pending = null;
    this.#save();
    return pending.draft;
  }

  #prune(): void {
    const keys = Object.keys(this.#state.entries);
    if (keys.length <= MAX_TRACKED) return;
    keys
      .sort((a, b) => (this.#state.entries[a]?.seen ?? 0) - (this.#state.entries[b]?.seen ?? 0))
      .slice(0, keys.length - MAX_TRACKED)
      .forEach((key) => {
        delete this.#state.entries[key];
      });
  }

  #load(): State {
    try {
      if (!existsSync(this.#file)) return { entries: {}, pending: null };
      const raw = JSON.parse(readFileSync(this.#file, 'utf8')) as Partial<State>;
      const entries =
        raw.entries && typeof raw.entries === 'object' && !Array.isArray(raw.entries)
          ? raw.entries
          : {};
      const pending =
        raw.pending && typeof raw.pending === 'object' && Array.isArray(raw.pending.draft?.steps)
          ? raw.pending
          : null;
      return { entries, pending };
    } catch {
      // Un fichero roto no tumba nada: se empieza de cero.
      return { entries: {}, pending: null };
    }
  }

  #save(): void {
    try {
      mkdirSync(dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.#state));
      renameSync(tmp, this.#file);
    } catch {
      // Sin disco no se ofrece nada nuevo; el turno sigue igual.
    }
  }
}
