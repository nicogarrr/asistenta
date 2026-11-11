/**
 * Aviso cuando se cae una conexión (Google, Spotify) que hay que volver a dar.
 *
 * Grok Bot avisa cuando una conexión necesita reconectarse en vez de fallar en silencio
 * (https://docs.x.ai/grok-bot/computer-and-apps, Stripe: «a Bot tells you when it needs
 * reconnecting»). Aquí, cuando Google contestaba `invalid_grant` (permiso retirado, o la
 * app «en prueba», que Google corta cada 7 días) se borraba el token y lo único que se veía
 * era que el resumen de la mañana salía sin calendario. Ahora llega UN mensaje al chat con
 * lo que ha pasado, qué deja de funcionar y la orden para volver a conectarlo.
 *
 * - Un aviso por servicio y caída (el token se borra al caer, así que no se repite), y como
 *   mucho uno cada 12 h por servicio aunque se reconecte y vuelva a caer.
 * - Solo dice; no reconecta nada solo.
 */
export type ServicioConexion = 'google' | 'spotify';

const AVISO_CADA_MS = 12 * 60 * 60_000;

type Listener = (servicio: ServicioConexion, texto: string) => void;
let listener: Listener | null = null;
const ultimo = new Map<ServicioConexion, number>();

/** Quién recibe el aviso (el daemon: el chat del dueño). null = nadie (pruebas, `pa`). */
export function alCaerConexion(next: Listener | null): void {
  listener = next;
  ultimo.clear();
}

export function textoConexionCaida(servicio: ServicioConexion): string {
  if (servicio === 'google')
    return [
      '🔌 Google se ha desconectado: retiró el permiso (lo quitaste en tu cuenta, cambiaste la contraseña o la app de Google está «en prueba», que caduca cada 7 días).',
      'Mientras, no veo tu calendario, tus contactos ni tu Drive, y el resumen de la mañana sale sin ellos.',
      'Para volver: /google conectar (se abre el permiso en el navegador del PC). Para que no caduque cada semana: en Google Cloud → Pantalla de consentimiento → «Publicar app».',
    ].join('\n');
  return [
    '🔌 Spotify se ha desconectado: retiró el permiso.',
    'Mientras, no puedo poner música ni ver qué suena.',
    'Para volver: /spotify conectar.',
  ].join('\n');
}

/** Lo llama quien ve el `invalid_grant`. Nunca lanza: avisar no puede romper la llamada. */
export function avisarConexionCaida(servicio: ServicioConexion, now: number = Date.now()): boolean {
  const fn = listener;
  if (!fn) return false;
  const last = ultimo.get(servicio);
  if (last !== undefined && now - last < AVISO_CADA_MS) return false;
  ultimo.set(servicio, now);
  try {
    fn(servicio, textoConexionCaida(servicio));
  } catch {}
  return true;
}
