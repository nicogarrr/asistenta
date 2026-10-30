/**
 * La página en la que quedó el navegador cuando una llamada suya LANZÓ un error.
 *
 * Una llamada que termina bien lleva la URL en `details.pageUrl`
 * (src/tools/browser.ts); una que lanza no tiene `details`, y sin esto un clic
 * que llega a Gmail y luego falla (un timeout esperando un selector, por
 * ejemplo) no contaba como contenido privado leído. La herramienta la apunta
 * aquí por id de llamada y el agente la recoge (una sola vez) al cerrar la
 * llamada para dársela al Gate. Acotado: nunca crece sin límite.
 */
const pages = new Map<string, string>();
const MAX_PENDING = 256;

export function notePageAfterFailedCall(callId: string, url: string | undefined): void {
  if (!callId || !url) return;
  pages.delete(callId);
  pages.set(callId, url);
  while (pages.size > MAX_PENDING) {
    const oldest = pages.keys().next().value;
    if (oldest === undefined) break;
    pages.delete(oldest);
  }
}

/** Devuelve y olvida la página apuntada para esa llamada (o undefined). */
export function takePageAfterFailedCall(callId: string): string | undefined {
  const url = pages.get(callId);
  pages.delete(callId);
  return url;
}
