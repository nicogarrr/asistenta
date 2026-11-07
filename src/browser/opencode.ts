import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * OpenCode Browse (https://github.com/anomalyco/browse, MIT): una extensión de Chrome y un
 * relay local que dejan usar el Chrome NORMAL del dueño, con sus pestañas y sesiones
 * abiertas. Chrome 136+ ya no deja depurar el perfil por defecto con
 * --remote-debugging-port, y por eso la ruta CDP usa un perfil aparte. La extensión entra por
 * chrome.debugger, y el relay ofrece un endpoint CDP normal en 127.0.0.1:19988 al que
 * Playwright se conecta con connectOverCDP. Las herramientas de Asistenta no cambian:
 * solo cambia el navegador que hay debajo.
 *
 * El relay pide un token (el archivo relay-token, legible solo por el usuario), y ese
 * token nunca se escribe en el log.
 */
export const OPENCODE_DEFAULT_URL = 'http://127.0.0.1:19988';

export const OPENCODE_INSTALL_HINT =
  'Instala OpenCode Browse en el PC (PowerShell: irm https://opencode.ai/browse/install.ps1 | iex), ' +
  'añade la extensión «browse» a Chrome y emparéjala; o quita PA_BROWSER=opencode del .env.';

/** Dónde deja browse el token del relay: igual en Windows (bajo %USERPROFILE%), macOS y Linux. */
export function opencodeTokenPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (env.PA_BROWSER_OPENCODE_TOKEN_FILE) return env.PA_BROWSER_OPENCODE_TOKEN_FILE;
  const data = env.XDG_DATA_HOME || join(home, '.local', 'share');
  return join(data, 'browse', 'relay-token');
}

/** Solo loopback: el endpoint CDP del relay únicamente responde en 127.0.0.1, y el token no debe salir del equipo. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      (u.protocol === 'http:' || u.protocol === 'ws:') &&
      (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]')
    );
  } catch {
    return false;
  }
}

export interface OpencodeDeps {
  url?: string;
  tokenPath?: string;
  readToken?: (path: string) => Promise<string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Pide al relay su URL WebSocket de CDP (con el token ya puesto) para connectOverCDP.
 * Cada fallo explica qué falta en palabras de usuario, sin el token.
 */
export async function opencodeEndpoint(deps: OpencodeDeps = {}): Promise<string> {
  const url = (deps.url || OPENCODE_DEFAULT_URL).replace(/\/+$/, '');
  if (!isLoopbackUrl(url)) {
    throw new Error(`PA_BROWSER_OPENCODE_URL tiene que ser de este equipo (127.0.0.1), no ${url}.`);
  }
  const tokenPath = deps.tokenPath ?? opencodeTokenPath();
  let token: string;
  try {
    token = (await (deps.readToken ?? ((p) => readFile(p, 'utf8')))(tokenPath)).trim();
  } catch {
    throw new Error(
      `OpenCode Browse no está instalado (no encuentro su token). ${OPENCODE_INSTALL_HINT}`,
    );
  }
  if (!token) throw new Error(`El token de OpenCode Browse está vacío. ${OPENCODE_INSTALL_HINT}`);
  const doFetch = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${url}/json/version`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 5_000),
    });
  } catch {
    throw new Error(
      'El relay de OpenCode Browse no responde en este equipo. Se arranca solo al usar «browse»; ' +
        'prueba «browse status» en PowerShell.',
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      'El relay de OpenCode Browse no acepta su token. Vuelve a ejecutar «browse install».',
    );
  }
  if (!res.ok) throw new Error(`El relay de OpenCode Browse respondió ${res.status}.`);
  const body = (await res.json().catch(() => ({}))) as { webSocketDebuggerUrl?: unknown };
  const ws = body.webSocketDebuggerUrl;
  if (typeof ws !== 'string' || !isLoopbackUrl(ws)) {
    throw new Error('El relay de OpenCode Browse no dio una dirección de control válida.');
  }
  return ws;
}
