/**
 * F14 — `pa doctor`: cómo está expuesto el panel web.
 *
 * El panel solo escucha en 127.0.0.1 (startWebUi lo impone). Para verlo desde
 * el móvil la vía recomendada es `tailscale serve` (docs/panel-remoto.md), que
 * exige añadir el nombre .ts.net a PA_WEB_ALLOWED_HOSTS. Estas líneas dicen si
 * el panel arranca, dónde, y avisan de lo que lo dejaría flojo.
 */
import { parseAllowedHosts } from './webui/server.js';

const MIN_TOKEN = 24;

/**
 * El token del panel tal como lo usa el daemon: sin espacios ni `\r` sueltos.
 * Un .env editado en Windows deja `PA_WEB_TOKEN=abc\r` o un espacio final; el
 * doctor ya lo recortaba y decía «bien», pero el daemon exigía el token con el
 * espacio y el panel rechazaba siempre el token correcto.
 */
export function panelTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.PA_WEB_TOKEN?.trim() ?? '';
}

/** PA_WEB_PORT como número de puerto, o null si no es un puerto válido. */
function panelPort(rawPort: string): number | null {
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return port;
}

/**
 * Lo que el daemon necesita para encender el panel, con las mismas reglas que
 * `pa doctor`. Antes el daemon no miraba el puerto (un `PA_WEB_PORT=abc` acababa
 * en un fallo raro) y, sin token, solo dejaba un log técnico. Ahora dice en
 * castellano llano por qué no arranca y qué hacer.
 */
export type PanelStart =
  | { kind: 'off' }
  | { kind: 'start'; port: number; token: string }
  | { kind: 'problem'; message: string; problem: 'panel-puerto' | 'panel-token' };

export function panelStartPlan(env: NodeJS.ProcessEnv = process.env): PanelStart {
  const rawPort = env.PA_WEB_PORT?.trim();
  if (!rawPort) return { kind: 'off' };
  const port = panelPort(rawPort);
  if (port === null) {
    return {
      kind: 'problem',
      message: `El panel web no se ha encendido: PA_WEB_PORT=${rawPort} no es un puerto válido. Pon en .env un número entre 1 y 65535 (por ejemplo PA_WEB_PORT=8787) y reinicia Asistenta.`,
      problem: 'panel-puerto',
    };
  }
  const token = panelTokenFromEnv(env);
  if (!token) {
    return {
      kind: 'problem',
      message: `El panel web no se ha encendido: falta PA_WEB_TOKEN en .env. Añade una línea PA_WEB_TOKEN= con ${MIN_TOKEN} o más letras y números al azar y reinicia Asistenta.`,
      problem: 'panel-token',
    };
  }
  return { kind: 'start', port, token };
}

export function panelDoctorLines(env: NodeJS.ProcessEnv = process.env): string[] {
  const rawPort = env.PA_WEB_PORT?.trim();
  if (!rawPort) return ['panel web       off (PA_WEB_PORT y PA_WEB_TOKEN para activarlo)'];
  const port = panelPort(rawPort);
  if (port === null) {
    return [`panel web       NO ARRANCA: PA_WEB_PORT=${rawPort} no es un puerto válido`];
  }
  const token = panelTokenFromEnv(env);
  if (!token) return ['panel web       NO ARRANCA: falta PA_WEB_TOKEN'];
  const lines = [`panel web       http://127.0.0.1:${port} (solo este PC)`];
  if (token.length < MIN_TOKEN) {
    lines.push(
      `panel token     CORTO (${token.length} caracteres): usa ${MIN_TOKEN}+ al azar, sobre todo si lo abres desde el móvil`,
    );
  }
  const raw = (env.PA_WEB_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  const hosts = parseAllowedHosts(env.PA_WEB_ALLOWED_HOSTS);
  if (raw.length > hosts.length) {
    lines.push(
      'panel hosts     comodines ignorados en PA_WEB_ALLOWED_HOSTS: cada nombre va exacto',
    );
  }
  for (const h of hosts) {
    lines.push(
      h.endsWith('.ts.net')
        ? `panel remoto    ${h} (Tailscale: solo tus dispositivos)`
        : `panel remoto    ${h}: OJO, no es de Tailscale; asegúrate de que ese proxy pide login y usa https`,
    );
  }
  return lines;
}
