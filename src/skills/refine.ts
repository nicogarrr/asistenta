/**
 * Mejora de skills DURANTE el uso (bucle de aprendizaje estilo Hermes), no
 * solo en el evolve semanal.
 *
 * El flujo de lecciones (lessons.ts) ya guarda "si X falla, Y funciono" en la
 * categoria lecciones, pero esa leccion solo se aplica si el modelo la busca.
 * Una leccion vista una vez puede ser ruido; vista dos o mas veces (su version
 * cuenta reincidencias, porque save() con el mismo nombre sube version) es un
 * patron, y el sitio donde rinde es la ficha del skill afectado: este modulo
 * la anota ahi, en cuanto se aprende.
 *
 * Reglas deliberadas:
 *
 * - Nunca reescribe pasos. Anade una nota con fecha y recuento via save(),
 *   que preserva pasos, description y el rastro de Notes. Un bucle que
 *   reescribe recetas solo es un bucle que nadie puede auditar.
 * - Idempotente: si el skill ya tiene una nota con ese par fallo->arreglo no
 *   se apila otra. El dueno puede borrar la nota editando el SKILL.md y el
 *   bucle no la repone mientras la leccion no cambie.
 * - Nunca lanza: aprender es un extra; la tarea del usuario manda.
 */
import { LESSON_CATEGORY } from './lessons.js';
import type { SkillStore } from './store.js';

/** Una leccion mejora un skill a partir de su segunda aparicion. */
export const REFINE_MIN_OCCURRENCES = 2;

const LESSON_NAME = /^Si ([a-z0-9:_-]+) falla, probar ([a-z0-9:_-]+)$/i;

/**
 * Anota en el skill afectado las lecciones reincidentes recien guardadas.
 * Devuelve los ids de skills anotados. Nunca lanza.
 */
export function refineFromLessons(
  store: SkillStore,
  lessonIds: readonly string[],
  day: string,
): string[] {
  const refined: string[] = [];
  for (const id of lessonIds) {
    try {
      const lesson = store.read(id);
      if (!lesson || lesson.category !== LESSON_CATEGORY) continue;
      if (lesson.version < REFINE_MIN_OCCURRENCES) continue;
      const m = LESSON_NAME.exec(lesson.name);
      if (!m) continue;
      const [, failed, worked] = m;
      if (!failed || !worked) continue;
      const tool = failed.split(':')[0] ?? failed;
      const target = store
        .list()
        .find(
          (s) =>
            s.category !== LESSON_CATEGORY &&
            (s.id === tool || s.id.includes(tool) || s.name.toLowerCase().includes(tool)),
        );
      if (!target) continue;
      if (target.notes.some((n) => n.includes(failed) && n.includes(worked))) continue;
      store.save({
        name: target.name,
        description: target.description,
        category: target.category,
        whenToUse: target.whenToUse,
        steps: target.steps,
        notes: [
          `Leccion aplicada en uso (${day}): si ${failed} falla, prueba ${worked} (vista ${lesson.version} veces).`,
        ],
      });
      refined.push(target.id);
    } catch {
      // Una anotacion que no se puede escribir no vale romper la tarea del usuario.
    }
  }
  return refined;
}
