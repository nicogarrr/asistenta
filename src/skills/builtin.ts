/**
 * Skills de ingeniería que vienen con Asistenta (ROADMAP, «Seleccionado para
 * adaptar» 2: diagnosing-bugs y TDD, adaptados con redacción propia).
 *
 * Dos reglas:
 *
 * 1. Se siembran una sola vez y nunca pisan una edición del usuario: si ya existe
 *    un SKILL.md con ese id, se deja tal cual (la tienda es editable a mano).
 * 2. Se cargan solo al programar: su línea en el índice `<skills>` del contexto
 *    solo aparece cuando la petición suena a código. Fuera de eso no gastan
 *    tokens en cada turno; `skills list/search` las sigue encontrando.
 */
import { log } from '../log.js';
import { type SkillStore, slugify } from './store.js';
import type { Skill, SkillDraft } from './types.js';

/** Categoría que marca una skill como «solo al programar». */
export const CODING_CATEGORY = 'programacion';

export const BUILTIN_SKILLS: readonly SkillDraft[] = [
  {
    name: 'Diagnosticar un bug',
    description: 'Del síntoma real a la causa, con evidencia y sin adivinar.',
    category: CODING_CATEGORY,
    whenToUse:
      'Programando: algo falla, da un resultado raro o un test está rojo y no se sabe por qué.',
    steps: [
      'Escribe el síntoma exacto: entrada, salida esperada, salida real y el error literal.',
      'Reprodúcelo con el caso más pequeño posible antes de tocar código.',
      'Lee el código del camino que falla y formula una hipótesis concreta de la causa.',
      'Comprueba la hipótesis con un dato (log, test, depurador); si no cuadra, descártala y vuelve al paso 3.',
      'Cuando la causa esté probada, aplica la skill tdd-test-rojo-antes-del-arreglo para el arreglo.',
      'Cuenta la causa raíz, la prueba y lo que queda sin verificar.',
    ],
    notes: [
      'Incluida con Asistenta (ROADMAP: skills de ingeniería). Editable: tus cambios no se pisan.',
      'No cambies varias cosas a la vez: si el fallo desaparece no sabrás cuál lo arregló.',
    ],
  },
  {
    name: 'TDD: test rojo antes del arreglo',
    description: 'Síntoma real, test que falla, arreglo mínimo y comprobación.',
    category: CODING_CATEGORY,
    whenToUse: 'Programando: arreglar un bug o añadir una función con tests.',
    steps: [
      'Escribe un test que reproduzca el síntoma real o el comportamiento pedido.',
      'Ejecútalo y confirma que falla por el motivo esperado, no por un error del propio test.',
      'Haz el cambio mínimo que lo pone en verde.',
      'Ejecuta la suite relacionada, el typecheck y el lint; todo en verde.',
      'Limpia el código sin cambiar el comportamiento y vuelve a ejecutar los tests.',
      'Da por listo solo con la prueba: el test rojo antes y verde después.',
    ],
    notes: [
      'Incluida con Asistenta (ROADMAP: skills de ingeniería). Editable: tus cambios no se pisan.',
    ],
  },
];

/** Ids que tendrán las skills incluidas (slug del nombre). */
export const BUILTIN_SKILL_IDS: readonly string[] = BUILTIN_SKILLS.map((s) => slugify(s.name));

/**
 * Crea en la tienda las skills incluidas que falten. Devuelve los ids creados.
 * Nunca sobrescribe una existente (ni vuelve a crear una que el usuario borró
 * mientras el fichero exista); un fallo de escritura se registra y no
 * tumba el arranque.
 */
export function seedBuiltinSkills(
  store: SkillStore,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const created: string[] = [];
  // Opt-out explícito: PA_BUILTIN_SKILLS=0 no siembra nada.
  if (env.PA_BUILTIN_SKILLS === '0') return created;
  for (const draft of BUILTIN_SKILLS) {
    const id = slugify(draft.name);
    try {
      if (store.read(id)) continue;
      created.push(store.save(draft));
    } catch (err) {
      log.warn('builtin skill seed failed', { id, err: String(err) });
    }
  }
  return created;
}

/**
 * ¿La petición suena a programación? Heurística local, determinista y sin LLM,
 * como el router: mejor no cargar una skill que gastar tokens en cada charla.
 */
const CODING_SIGNALS =
  /\b(c[oó]digo|programa(r|ndo|ci[oó]n)?|bugs?|debug(ear|uear)?|depura(r|ndo)?|tests?|vitest|jest|pytest|tdd|refactor(iza(r)?)?|compila(r|ci[oó]n)?|typecheck|lint|stack ?trace|traceback|repo(sitorio)?|commit|pull request|pr|merge|git|npm|typescript|javascript|python|tsc|endpoint|sql|regex)\b|\.(ts|tsx|js|mjs|py|rs|go|java|json)\b|```/i;

export function looksLikeCoding(request: string | undefined): boolean {
  if (!request) return false;
  return CODING_SIGNALS.test(request);
}

/**
 * Las skills que deben ir en el índice del contexto para esta petición: las de
 * programación solo si la petición suena a código. Sin petición conocida, se
 * ocultan (no hay señal de que se esté programando).
 */
export function skillsForContext<T extends Pick<Skill, 'category' | 'disabled'>>(
  skills: readonly T[],
  request: string | undefined,
): T[] {
  // Una skill desactivada por el dueño («quita la de X») no entra nunca.
  const active = skills.filter((s) => !s.disabled);
  if (looksLikeCoding(request)) return active;
  return active.filter((s) => s.category !== CODING_CATEGORY);
}
