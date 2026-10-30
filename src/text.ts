/**
 * Normalización de texto compartida. Antes había cinco copias de `fold` y tres
 * de `hostOf` con pequeñas diferencias (una no quitaba el punto final de un
 * nombre de host completo, «amazon.es.»).
 */

/** Minúsculas y sin tildes/diacríticos: «Árbol Ñandú» → «arbol nandu». */
export function foldAccents(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Nombre de host comparable: minúsculas y sin el punto final de un FQDN
 * («Amazon.ES.» → «amazon.es»). Para DNS y para Chromium son el mismo host.
 */
export function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, '');
}
