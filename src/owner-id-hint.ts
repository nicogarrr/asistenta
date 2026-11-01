/**
 * Primer uso: si al instalar se guardó un ID de Telegram equivocado, el dueño
 * escribe al bot y solo recibe «Este asistente es privado.»; en el PC no quedaba
 * más que una línea técnica en el log («unauthorised sender»). Esto deja en la
 * consola una línea en castellano con el ID que ha escrito y qué hacer, una vez
 * por persona. No cambia quién está autorizado.
 */

/** Distintas personas avisadas como mucho en una ejecución (sin crecer sin fin). */
const MAX_AVISOS = 20;

export function makeStrangerHint(limit = MAX_AVISOS) {
  const seen = new Set<number>();
  return (msg: string, fields?: Record<string, unknown>): string | null => {
    if (msg !== 'unauthorised sender') return null;
    const id = fields?.userId;
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) return null;
    if (seen.has(id) || seen.size >= limit) return null;
    seen.add(id);
    const raw = fields?.username;
    const user = typeof raw === 'string' ? raw.replace(/[^A-Za-z0-9_]/g, '').slice(0, 32) : '';
    return (
      `Alguien que no está en la lista ha escrito al bot (ID de Telegram ${id}${user ? `, @${user}` : ''}) ` +
      'y le he contestado que es privado. Si eras tú, el ID guardado no es el tuyo: ' +
      'doble clic en instalar.bat y escribe «hola» al bot, o guárdalo con pa vault set-stdin telegram:allowedUserIds.'
    );
  };
}
