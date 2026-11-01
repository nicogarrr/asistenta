/**
 * Auto-chequeo de una habilidad antes de darla por buena (idea de Voyager: una
 * skill solo entra en la biblioteca si pasa una verificación).
 *
 * Aquí no se ejecuta nada: se comprueba que la receta se puede seguir hoy en
 * este PC. Pasos reales, herramientas citadas que existen, lo que necesita
 * configurado (correo, calendario…) y, si usa una herramienta de la fábrica,
 * que esté instalada (probada en el sandbox y aprobada por el dueño). Lo que no
 * se puede comprobar se dice como «sin comprobar», nunca como «listo».
 */
import type { Skill } from './types.js';

export interface SelfCheckEnv {
  /** Nombres de las herramientas cargadas ahora (incluye fab_<id> instaladas). */
  toolNames?: readonly string[];
  /** Requisitos que están configurados (correo, calendario, navegador…). */
  capabilities?: ReadonlySet<string>;
}

export interface SelfCheckResult {
  /** Lista para usarse: sin problemas y nada sin comprobar. */
  ready: boolean;
  problems: string[];
  unchecked: string[];
  /** Una o dos frases en castellano llano para el dueño. */
  summary: string;
}

const MIN_STEP_CHARS = 4;

export function checkSkill(skill: Skill, env: SelfCheckEnv = {}): SelfCheckResult {
  const problems: string[] = [];
  const unchecked: string[] = [];
  const steps = skill.steps.filter((step) => step.trim().length >= MIN_STEP_CHARS);
  if (steps.length === 0) problems.push('no tiene pasos que se puedan seguir');
  if (!skill.whenToUse.trim() && !skill.description.trim()) {
    problems.push('no dice cuándo usarla');
  }
  for (const need of skill.needs ?? []) {
    if (!env.capabilities) unchecked.push(need);
    else if (!env.capabilities.has(need)) problems.push(`falta configurar ${need}`);
  }
  if (skill.tool) {
    if (!env.toolNames) unchecked.push(`la herramienta ${skill.tool}`);
    else if (!env.toolNames.includes(skill.tool)) {
      problems.push(
        `la herramienta ${skill.tool} no está instalada (hay que probarla y aprobarla)`,
      );
    }
  }
  const ready = problems.length === 0 && unchecked.length === 0 && !skill.disabled;
  return { ready, problems, unchecked, summary: summarize(skill, ready, problems, unchecked) };
}

function summarize(
  skill: Skill,
  ready: boolean,
  problems: readonly string[],
  unchecked: readonly string[],
): string {
  if (skill.disabled) return `«${skill.name}» está desactivada.`;
  if (ready) {
    return skill.outward
      ? `«${skill.name}» está lista. Antes de enviar, reservar o gastar nada te pediré permiso.`
      : `«${skill.name}» está lista.`;
  }
  const parts: string[] = [];
  if (problems.length > 0) parts.push(`Aún no funciona: ${problems.join('; ')}.`);
  if (unchecked.length > 0) parts.push(`Sin comprobar: ${unchecked.join(', ')}.`);
  return `«${skill.name}»: ${parts.join(' ')}`;
}
