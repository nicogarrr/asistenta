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

export function panelDoctorLines(env: NodeJS.ProcessEnv = process.env): string[] {
  const rawPort = env.PA_WEB_PORT?.trim();
  if (!rawPort) return ['panel web       off (PA_WEB_PORT y PA_WEB_TOKEN para activarlo)'];
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65_535) {
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
