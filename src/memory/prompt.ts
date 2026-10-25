/**
 * Bloques de memoria para el prompt: `<perfil>` y `<memory>`, cada uno con su
 * propio presupuesto.
 *
 * El perfil v2 (OwnerProfile) y el indice de memoria por chat
 * (renderMemoryContext) son dos fuentes distintas y no deben mezclarse: el
 * perfil son hechos que valen en todas las conversaciones y la memoria es lo
 * aprendido en ESTE chat. Antes el prompt podia acabar con el perfil dos veces
 * (el legado y el v2); aqui cada fuente tiene su etiqueta y `memoryBody` se
 * trata como el cuerpo ya renderizado del indice, nunca como otro perfil.
 *
 * Reglas deliberadas:
 * - `<perfil>` solo aparece si `load()` tiene al menos un hecho vigente. Un
 *   perfil con todos sus hechos sustituidos no dice nada y no debe gastar
 *   tokens.
 * - Cada bloque completo (etiquetas incluidas) se recorta a
 *   MEMORY_PROMPT_BLOCK_CAP. Un perfil gigante no puede empujar fuera del
 *   prompt la memoria del chat, ni al reves.
 * - La funcion es pura y nunca lanza: cualquier fallo de lectura o de render
 *   devuelve cadena vacia. Un prompt sin memoria es degradado, pero un turno
 *   que muere por leer un perfil corrupto es peor.
 */

/** Tope por bloque, contando las etiquetas de apertura y cierre. */
export const MEMORY_PROMPT_BLOCK_CAP = 6000;

/** Lo minimo que necesita el perfil para decidir y pintar sus hechos. */
export interface PromptProfile {
  render(): string;
  load(): Array<{ supersededBy: string | null }>;
}

export interface MemoryPromptInput {
  profile?: PromptProfile;
  /** Cuerpo del indice de memoria ya renderizado (renderMemoryContext().body). */
  memoryBody?: string;
}

/**
 * Envuelve un cuerpo en su etiqueta sin superar el tope. Si hay que recortar,
 * se conserva el principio (lo mas reciente y util) y se marca con ellipsis.
 */
function block(tag: string, raw: string): string {
  const body = raw.trim();
  if (!body) return '';
  const open = `<${tag}>\n`;
  const close = `\n</${tag}>`;
  const room = MEMORY_PROMPT_BLOCK_CAP - open.length - close.length;
  const clipped = body.length > room ? `${body.slice(0, Math.max(0, room - 1))}…` : body;
  return `${open}${clipped}${close}`;
}

/**
 * Construye la seccion de memoria para el prompt. Devuelve solo los bloques
 * con contenido, separados por una linea en blanco; sin memoria devuelve ''.
 */
export function buildMemoryPromptSection(input: MemoryPromptInput): string {
  try {
    const blocks: string[] = [];
    const profile = input.profile;
    if (profile) {
      const facts = profile.load();
      if (Array.isArray(facts) && facts.some((fact) => fact?.supersededBy === null)) {
        const rendered = profile.render();
        const perfil = typeof rendered === 'string' ? block('perfil', rendered) : '';
        if (perfil) blocks.push(perfil);
      }
    }
    const memoryBody = typeof input.memoryBody === 'string' ? input.memoryBody : '';
    const memory = block('memory', memoryBody);
    if (memory) blocks.push(memory);
    return blocks.join('\n\n');
  } catch {
    return '';
  }
}
