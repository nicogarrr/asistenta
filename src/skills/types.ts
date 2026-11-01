/**
 * Procedural memory: the shapes behind a "skill".
 *
 * Episodic memory (src/memory.ts) answers "what do I know about this user"; a
 * skill answers "how did I do this kind of task successfully before". One skill
 * is one reusable recipe: a name, when to reach for it, and the steps that
 * worked the last time.
 *
 * The on-disk shape follows the agentskills.io convention — a directory holding
 * a SKILL.md with YAML frontmatter plus Markdown — so a skill stays a file a
 * human can read, diff, fix by hand and send to someone else. `Skill` is that
 * file parsed; `SkillDraft` is what a writer hands to the store before an id, a
 * version and timestamps exist. Anything not expressible in the two is not part
 * of a skill on purpose: the format's simplicity is what keeps the agent's
 * learned knowledge inspectable.
 */

/**
 * Provenance of a recipe.
 *
 * `official` ships with the agent, `trusted` was curated by the user, and
 * `community` is anything the agent taught itself or imported. It travels with
 * the skill so a prompt can weigh a recipe nobody has vetted yet.
 */
export type SkillTrust = 'official' | 'trusted' | 'community';

export interface Skill {
  /** Slug of `name`; also the directory under the skills dir. */
  id: string;
  name: string;
  description: string;
  category: string;
  /** The request or situation that should make the agent reach for this skill. */
  whenToUse: string;
  /** One imperative line per step, in the order that worked. */
  steps: string[];
  /** Free-form lines: caveats, and the audit trail left by every `improve`. */
  notes: string[];
  /** Bumped on every edit, so "which recipe did we follow" is answerable later. */
  version: number;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds. */
  updatedAt: number;
  trust: SkillTrust;
  /** Desactivada por el dueño («quita la de X»): no entra en el índice ni se sigue. */
  disabled?: boolean;
  /**
   * Actúa hacia fuera o gasta (enviar, reservar, comprar, encender cosas). Solo
   * informa: los permisos los decide permissions.ts, nunca la skill.
   */
  outward?: boolean;
  /** Lo que tiene que estar configurado (correo, calendario, navegador…). */
  needs?: string[];
  /** Herramienta de la fábrica que usa (fab_<id>); tiene que estar instalada. */
  tool?: string;
}

/**
 * A skill before the store stamps it. `notes` is optional because most skills
 * are born from one successful run and have nothing to say about themselves yet.
 */
export interface SkillDraft {
  name: string;
  description: string;
  category: string;
  whenToUse: string;
  steps: string[];
  notes?: string[];
  /** Por defecto true en lo creado desde el chat: ante la duda, pide permiso. */
  outward?: boolean;
  needs?: string[];
  tool?: string;
}
