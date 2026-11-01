/**
 * Subagentes especialistas.
 *
 * Un especialista es un subagente con nombre, un prompt corto propio y una lista
 * blanca de herramientas (y, si la herramienta tiene acciones, de acciones). El
 * agente principal lo elige con `delegate(specialist: "web", task)`; un nombre
 * que no esta aqui cae en el subagente generico de siempre.
 *
 * Los prompts de los especialistas viven aqui y NO en el prompt de sistema del
 * agente principal: el hijo los recibe solo cuando se le delega una tarea.
 *
 * Mismo contrato que cualquier hijo (ver core/subagent.ts): historial nuevo, sin
 * transcript del padre, sin aprobaciones heredadas, y solo devuelve texto. Un
 * especialista sin efectos (`effectful: false`) solo puede leer; lo que haya que
 * enviar, guardar o encender lo hace el agente principal con su permiso normal.
 * Ningun prompt lleva secretos: solo instrucciones de estilo y de alcance.
 */

export interface SpecialistSpec {
  /** Nombre canonico, en minusculas y sin tildes. */
  readonly name: string;
  /** Nombre para mostrar (y para la pregunta de permiso). */
  readonly title: string;
  /** Instrucciones propias del especialista, en castellano y cortas. */
  readonly prompt: string;
  /** Lista blanca de herramientas que puede recibir el hijo. */
  readonly tools: readonly string[];
  /**
   * Acciones permitidas por herramienta. Si una herramienta aparece aqui, una
   * llamada con otra accion (o sin accion) se rechaza antes de ejecutarse.
   */
  readonly actions?: Readonly<Record<string, readonly string[]>>;
  /** true = sus herramientas tienen efectos y cada accion vuelve a pedir permiso. */
  readonly effectful: boolean;
  /** Ejemplos de tareas que encajan, para la descripcion de `delegate`. */
  readonly examples: readonly string[];
}

const COMMON_RULES =
  'No tienes historial previo ni permisos heredados. Haz solo la tarea pedida, sin inventar datos, y responde en castellano con un resumen corto y claro.';

function spec(s: SpecialistSpec): SpecialistSpec {
  return Object.freeze({
    ...s,
    tools: Object.freeze([...s.tools]),
    examples: Object.freeze([...s.examples]),
    ...(s.actions
      ? {
          actions: Object.freeze(
            Object.fromEntries(
              Object.entries(s.actions).map(([k, v]) => [k, Object.freeze([...v])]),
            ),
          ),
        }
      : {}),
  });
}

export const SPECIALISTS: Readonly<Record<string, SpecialistSpec>> = Object.freeze({
  web: spec({
    name: 'web',
    title: 'Web',
    prompt:
      'Eres el especialista web de Asistenta. Buscas en internet y lees páginas para responder con datos comprobados. Compara al menos dos fuentes cuando el dato importe, cita la URL de cada dato y di claramente lo que no encontraste. Solo lees: no rellenas formularios, no compras y no inicias sesión en nada.',
    tools: ['web', 'fetch', 'read', 'list'],
    effectful: false,
    examples: ['compara precios de un producto', 'busca el horario de una tienda'],
  }),
});

/** Alias que el modelo o el usuario usan para el mismo especialista. */
const ALIASES: Readonly<Record<string, string>> = Object.freeze({
  internet: 'web',
  buscar: 'web',
  busqueda: 'web',
});

function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

/** Especialista por nombre o alias; undefined si no existe (se usa el hijo generico). */
export function resolveSpecialist(name: unknown): SpecialistSpec | undefined {
  if (typeof name !== 'string') return undefined;
  const key = normalizeName(name);
  if (!key) return undefined;
  const canonical = Object.hasOwn(ALIASES, key) ? ALIASES[key] : key;
  return canonical !== undefined && Object.hasOwn(SPECIALISTS, canonical)
    ? SPECIALISTS[canonical]
    : undefined;
}

/** Nombres canonicos, en el orden del registro. */
export function specialistNames(): string[] {
  return Object.keys(SPECIALISTS);
}

/**
 * Herramientas efectivas del especialista: su lista blanca, estrechada por lo que
 * pida el caller. Un caller nunca puede ANADIR herramientas a un especialista.
 */
export function specialistToolNames(
  specialist: SpecialistSpec,
  requested?: readonly string[],
): string[] {
  if (requested === undefined) return [...specialist.tools];
  const out: string[] = [];
  for (const name of requested) {
    if (specialist.tools.includes(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Accion de una llamada si la herramienta del especialista esta acotada por acciones. */
export function specialistAllowsCall(
  specialist: SpecialistSpec,
  tool: string,
  args: unknown,
): boolean {
  if (!specialist.tools.includes(tool)) return false;
  const allowed = specialist.actions?.[tool];
  if (allowed === undefined) return true;
  const action =
    args && typeof args === 'object' ? (args as Record<string, unknown>).action : undefined;
  return typeof action === 'string' && allowed.includes(action);
}

export function buildSpecialistPrompt(specialist: SpecialistSpec, task: string): string {
  return [specialist.prompt, COMMON_RULES, '', `Tarea: ${task}`].join('\n');
}
