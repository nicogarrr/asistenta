/**
 * `pa panel`: abre el panel web en el navegador, ya con su token (Nico, 31 oct:
 * «actívalo por defecto»). El panel está encendido por defecto en 127.0.0.1:8787 con
 * un token guardado; aquí se abre `?token=…` una vez y la página lo guarda y lo quita
 * de la barra de direcciones. El token nunca se imprime ni se registra.
 */
import { spawn } from 'node:child_process';
import { panelStartPlan } from './panel-doctor.js';
import { ensurePanelToken, panelTokenPath } from './panel-token.js';

export interface PanelOpenDeps {
  env: NodeJS.ProcessEnv;
  stateDir: string;
  /** Abre la dirección en el navegador; false si no se pudo. */
  open: (url: string) => Promise<boolean>;
  print: (line: string) => void;
}

export async function panelCommand(deps: PanelOpenDeps): Promise<number> {
  const plan = panelStartPlan(deps.env, () => ensurePanelToken(deps.stateDir));
  if (plan.kind === 'off') {
    deps.print(
      'El panel está apagado (PA_WEB_PORT=0 en .env). Quita esa línea y reinicia Asistenta para encenderlo.',
    );
    return 1;
  }
  if (plan.kind === 'problem') {
    deps.print(plan.message);
    return 1;
  }
  const base = `http://127.0.0.1:${plan.port}/`;
  const opened = await deps.open(`${base}?token=${encodeURIComponent(plan.token)}`);
  if (!opened) {
    deps.print(
      plan.tokenAuto
        ? `No he podido abrir el navegador. Abre ${base} y pega el token que hay en ${panelTokenPath(deps.stateDir)}.`
        : `No he podido abrir el navegador. Abre ${base} y pega tu PA_WEB_TOKEN.`,
    );
    return 1;
  }
  deps.print(`Abriendo el panel: ${base} (si no carga, enciende Asistenta con «pa iniciar»).`);
  return 0;
}

/** Abre una dirección con el navegador del sistema, sin consola ni shell. */
export function openInBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const [cmd, args] =
    platform === 'win32'
      ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
      : platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
