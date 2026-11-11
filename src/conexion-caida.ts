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
 * - Si al caer no hay a quién decírselo (el PC recién arrancado: el resumen de la mañana
 *   pide el calendario antes de que escribas nada), el aviso queda guardado y sale con lo
 *   siguiente que llegue (`entregarAvisosPendientes`). Antes se perdía: el token ya estaba
 *   borrado y no había otra caída que avisara.
 */
export type ServicioConexion = 'google' | 'spotify';

const AVISO_CADA_MS = 12 * 60 * 60_000;

/** Devuelve false si ahora no hay chat al que mandarlo (el aviso se guarda). */
type Listener = (servicio: ServicioConexion, texto: string) => unknown;
let listener: Listener | null = null;
const ultimo = new Map<ServicioConexion, number>();
const pendientes = new Set<ServicioConexion>();

/** Quién recibe el aviso (el daemon: el chat del dueño). null = nadie (pruebas, `pa`). */
export function alCaerConexion(next: Listener | null): void {
  listener = next;
  ultimo.clear();
  pendientes.clear();
}

function entregar(fn: Listener, servicio: ServicioConexion, now: number): boolean {
  let ok: unknown = true;
  try {
    ok = fn(servicio, textoConexionCaida(servicio));
  } catch {}
  if (ok === false) {
    pendientes.add(servicio);
    return false;
  }
  pendientes.delete(servicio);
  ultimo.set(servicio, now);
  return true;
}

/** Los avisos que no tuvieron a quién llegar; los manda ahora si ya hay chat. */
export function entregarAvisosPendientes(now: number = Date.now()): number {
  const fn = listener;
  if (!fn || !pendientes.size) return 0;
  let n = 0;
  for (const servicio of [...pendientes]) if (entregar(fn, servicio, now)) n++;
  return n;
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
  return entregar(fn, servicio, now);
}
