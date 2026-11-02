import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Chrome del dueño con puerto de depuración SOLO en 127.0.0.1.
 *
 * Chrome 136 o superior no deja controlar por CDP el perfil por defecto del usuario
 * (https://developer.chrome.com/blog/remote-debugging-port), así que se usa un perfil
 * dedicado e iniciado una vez (escanear el QR de WhatsApp Web). Quien tenga acceso a
 * ese puerto controla esa sesión: por eso solo escucha en loopback, solo se usa desde
 * el chat del dueño y la URL del puerto nunca se escribe en el log con credenciales.
 */

export const CDP_HOST = '127.0.0.1';

export function cdpEndpoint(port: number): string {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`puerto de depuración no válido: ${String(port)}`);
  }
  return `http://${CDP_HOST}:${port}`;
}

/** Rutas habituales de Chrome por sistema, de la más a la menos probable. */
export function chromeCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === 'win32') {
    const bases = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(
      (b): b is string => Boolean(b),
    );
    return bases.map((b) => join(b, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  if (platform === 'darwin') {
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/google/chrome/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
}

export function findChrome(
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return chromeCandidates(platform, env).find((p) => exists(p)) ?? null;
}

/** Argumentos con los que se abre el Chrome del dueño. Sin nada de la URL ni de cookies. */
export function chromeArgs(dir: string, port: number): string[] {
  return [
    `--remote-debugging-port=${port}`,
    `--remote-debugging-address=${CDP_HOST}`,
    `--user-data-dir=${dir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
  ];
}

export interface CdpDeps {
  fetchVersion?: (endpoint: string) => Promise<boolean>;
  launch?: (exe: string, args: string[]) => void;
  find?: () => string | null;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

async function defaultFetchVersion(endpoint: string): Promise<boolean> {
  try {
    const res = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function defaultLaunch(exe: string, args: string[]): void {
  // Suelto del proceso de Asistenta: si ella se reinicia, el Chrome del dueño sigue.
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => undefined);
  child.unref();
}

/**
 * Deja un Chrome escuchando en `127.0.0.1:port` con el perfil `dir` y devuelve su
 * endpoint. Si ya hay uno, lo usa; si no, lo abre. Fallos: una línea en castellano.
 */
export async function ensureChromeDebugPort(
  dir: string,
  port: number,
  deps: CdpDeps = {},
): Promise<string> {
  const endpoint = cdpEndpoint(port);
  const alive = deps.fetchVersion ?? defaultFetchVersion;
  if (await alive(endpoint)) return endpoint;
  const exe = (deps.find ?? (() => findChrome()))();
  if (!exe) throw new Error('No encuentro Chrome instalado para abrir tu navegador.');
  (deps.launch ?? defaultLaunch)(exe, chromeArgs(dir, port));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const limit = deps.timeoutMs ?? 20_000;
  for (let waited = 0; waited < limit; waited += 500) {
    await sleep(500);
    if (await alive(endpoint)) return endpoint;
  }
  throw new Error(
    `Abrí Chrome pero no respondió en el puerto ${port}. Si ya tienes ese perfil abierto sin puerto, ciérralo y repite.`,
  );
}
