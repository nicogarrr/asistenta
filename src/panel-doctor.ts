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

/** Puerto del panel si no hay PA_WEB_PORT en .env: el panel está encendido por defecto. */
export const PANEL_DEFAULT_PORT = 8787;

/** PA_WEB_PORT=0 (o off/no/false) apaga el panel. */
function panelOff(rawPort: string): boolean {
  return ['0', 'off', 'no', 'false'].includes(rawPort.toLowerCase());
}

/**
 * Lo que el daemon necesita para encender el panel, con las mismas reglas que
 * `pa doctor`. Antes el daemon no miraba el puerto (un `PA_WEB_PORT=abc` acababa
 * en un fallo raro) y, sin token, solo dejaba un log técnico. Ahora dice en
 * castellano llano por qué no arranca y qué hacer.
 *
 * Nico (31 oct): «actívalo por defecto». Sin PA_WEB_PORT el panel escucha en
 * 127.0.0.1:8787 (`porDefecto`); sin PA_WEB_TOKEN usa el token guardado que da
 * `storedToken` (`tokenAuto`). PA_WEB_PORT=0 lo apaga. Un PA_WEB_TOKEN puesto gana.
 */
export type PanelStart =
  | { kind: 'off' }
  | { kind: 'start'; port: number; token: string; porDefecto?: true; tokenAuto?: true }
  | { kind: 'problem'; message: string; problem: 'panel-puerto' | 'panel-token' };

export function panelStartPlan(
  env: NodeJS.ProcessEnv = process.env,
  storedToken?: () => string,
): PanelStart {
  const rawPort = env.PA_WEB_PORT?.trim() ?? '';
  if (panelOff(rawPort)) return { kind: 'off' };
  const porDefecto = rawPort === '';
  const port = porDefecto ? PANEL_DEFAULT_PORT : panelPort(rawPort);
  if (port === null) {
    return {
      kind: 'problem',
      message: `El panel web no se ha encendido: PA_WEB_PORT=${rawPort} no es un puerto válido. Pon en .env un número entre 1 y 65535 (por ejemplo PA_WEB_PORT=8787) y reinicia Asistenta.`,
      problem: 'panel-puerto',
    };
  }
  let token = panelTokenFromEnv(env);
  let tokenAuto = false;
  let storeFailed = false;
  if (!token && storedToken) {
    try {
      token = storedToken().trim();
      tokenAuto = Boolean(token);
    } catch {
      storeFailed = true;
    }
  }
  if (!token) {
    return {
      kind: 'problem',
      message: storeFailed
        ? `El panel web no se ha encendido: no he podido guardar su token en la carpeta de Asistenta. Añade a .env una línea PA_WEB_TOKEN= con ${MIN_TOKEN} o más letras y números al azar y reinicia Asistenta.`
        : `El panel web no se ha encendido: falta PA_WEB_TOKEN en .env. Añade una línea PA_WEB_TOKEN= con ${MIN_TOKEN} o más letras y números al azar y reinicia Asistenta.`,
      problem: 'panel-token',
    };
  }
  return {
    kind: 'start',
    port,
    token,
    ...(porDefecto ? { porDefecto: true as const } : {}),
    ...(tokenAuto ? { tokenAuto: true as const } : {}),
  };
}

export function panelDoctorLines(env: NodeJS.ProcessEnv = process.env): string[] {
  const rawPort = env.PA_WEB_PORT?.trim() ?? '';
  if (panelOff(rawPort)) {
    return ['panel web       off (PA_WEB_PORT=0 en .env; quita esa línea para encenderlo)'];
  }
  const port = rawPort === '' ? PANEL_DEFAULT_PORT : panelPort(rawPort);
  if (port === null) {
    return [`panel web       NO ARRANCA: PA_WEB_PORT=${rawPort} no es un puerto válido`];
  }
  const token = panelTokenFromEnv(env);
  const lines = [`panel web       http://127.0.0.1:${port} (solo este PC; ábrelo con «pa panel»)`];
  if (!token) {
    lines.push(
      'panel token     automático, guardado en la carpeta de estado (PA_WEB_TOKEN lo cambia)',
    );
  } else if (token.length < MIN_TOKEN) {
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

/** Lo que el panel no pudo hacer al escuchar en el puerto, ya en castellano. */
export interface PanelListenProblem {
  problem: 'panel-ocupado' | 'panel-fallo';
  message: string;
}

/**
 * Error al encender el panel (el puerto ya estaba bien escrito). En Windows es
 * corriente que otro programa —o una segunda Asistenta— tenga el puerto, o que
 * Windows lo reserve (EACCES). Antes solo quedaba «panel web no arrancó» en el log.
 */
export function panelListenProblem(err: unknown, port: number): PanelListenProblem {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EADDRINUSE' || code === 'EACCES') {
    const other = port < 65535 ? port + 1 : 8788;
    return {
      problem: 'panel-ocupado',
      message: `El panel web no se ha encendido: el puerto ${port} lo está usando otro programa (¿Asistenta abierta dos veces?) o Windows no deja usarlo. Cambia PA_WEB_PORT en .env, por ejemplo a ${other}, y reinicia Asistenta.`,
    };
  }
  return {
    problem: 'panel-fallo',
    message:
      'El panel web no se ha encendido por un fallo inesperado. Ejecuta «pa doctor» en el PC para ver qué pasa.',
  };
}

export type PanelProblem =
  | Extract<PanelStart, { kind: 'problem' }>['problem']
  | PanelListenProblem['problem'];

/**
 * Lo que el arranque cuenta del panel: su dirección si de verdad escucha (línea de
 * consola) o el problema (aviso por Telegram, una vez). Espera poco al panel.
 */
export async function panelBootFacts(
  plan: PanelStart,
  started?: Promise<string | PanelListenProblem>,
  waitMs = 5_000,
): Promise<{ url?: string; problems: PanelProblem[] }> {
  if (plan.kind === 'problem') return { problems: [plan.problem] };
  if (plan.kind === 'off' || !started) return { problems: [] };
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), waitMs);
    timer.unref?.();
  });
  const got = await Promise.race([started, late]).finally(() => clearTimeout(timer));
  if (typeof got === 'string') return { url: got, problems: [] };
  // Con el puerto por defecto ocupado basta la línea de la consola: el dueño no pidió
  // ese puerto y Asistenta sigue funcionando sin panel. Sin aviso por Telegram.
  if (got && plan.kind === 'start' && plan.porDefecto && got.problem === 'panel-ocupado') {
    return { problems: [] };
  }
  if (got) return { problems: [got.problem] };
  return { problems: [] };
}
