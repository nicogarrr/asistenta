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

/**
 * Host comparable de una URL (`normalizeHostname` sobre `new URL(url).hostname`),
 * o `null` si el texto no es una URL. Única fuente para los `hostOf` del navegador,
 * las descargas y las vigilancias de precio.
 */
export function urlHostname(url: string): string | null {
  try {
    return normalizeHostname(new URL(url).hostname);
  } catch {
    return null;
  }
}

/**
 * `text.slice(0, end)` sin partir un emoji (par sustituto) por la mitad: un corte a
 * ciegas dejaba medio carácter suelto, que Telegram enseña como «�» y que un
 * proveedor de IA puede rechazar como JSON inválido.
 */
export function sliceSafe(text: string, end: number): string {
  const cut = text.slice(0, Math.max(0, end));
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}
