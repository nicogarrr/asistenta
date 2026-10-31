import { execFile } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir, uptime } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clearStoppedOnPurpose,
  type DaemonRunState,
  describeDecision,
  readDaemonStartedAt,
  readStoppedOnPurpose,
  readWatchdogLast,
  saveWatchdogLast,
  schtasksArgs,
  startDaemonTaskArgs,
  WATCHDOG_INTERVAL_MIN,
  watchdogDecide,
  watchdogEnabled,
  watchdogLastLine,
  watchdogTaskXml,
} from './autostart-watchdog.js';

import { lockHeld } from './autoupdate.js';
import {
  autoupdateStatusLine,
  daemonRunState,
  maybeLaunchAutoupdate,
  sendOwnerTelegram,
} from './autoupdate-cli.js';
import { BOOT_NOTICE_FILE, formatBootNoticeResult, readBootNoticeResult } from './boot-notice.js';

import { paths } from './paths.js';
import { formatStartupRecord, readStartupRecord, STARTUP_RECORD_FILE } from './startup-record.js';
import { unlock, vaultGet } from './vault.js';

export function autostartRepo(moduleUrl: string = import.meta.url): string {
  return fileURLToPath(new URL('..', moduleUrl));
}

type ExecError = Error & { code?: unknown; killed?: boolean };
type ExecResult = { error: ExecError | null; stdout: string; stderr: string };

function runExe(exe: string, flags: string[], timeout = 120_000): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    execFile(
      exe,
      flags,
      { windowsHide: true, timeout, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) =>
        resolve({
          error: (error as ExecError | null) ?? null,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        }),
    );
  });
}

const AUTOSTART_FAIL_HINTS: Record<string, string> = {
  compilar: 'falta compilar Asistenta. Ejecuta instalar.bat (o npm run build) y repite.',
  navegador:
    'falta preparar el navegador de Asistenta. Ejecuta deploy\\browserd\\setup-browserd.ps1 y repite.',
  archivos: 'faltan archivos de Asistenta. Vuelve a descargarla (o haz git pull) y repite.',
  node: 'Asistenta necesita Node 24 o más nuevo. Instálalo desde nodejs.org y repite.',
  parada: 'no pude parar Asistenta antes de quitar el autoarranque. Ejecuta pa stop y repite.',
  permiso:
    'Windows no dio permiso para crear las tareas programadas. Repite desde una terminal abierta como administrador.',
};

/** Frase clara (qué pasó y qué hacer) para un fallo del instalador; nunca vuelca su stderr. */
export function autostartFailureMessage(error: ExecError, stderr: string): string {
  const head = 'Autoarranque no completado: ';
  if (error.code === 'ENOENT') {
    return `${head}no encuentro Windows PowerShell en este PC, y sin él no puedo registrar el arranque.`;
  }
  if (error.killed) {
    return `${head}el instalador tardó más de 2 minutos y lo paré. Vuelve a probar; si se repite, reinicia el PC y repite.`;
  }
  const motivo = /^MOTIVO=([a-z]+)\s*$/m.exec(stderr)?.[1] ?? '';
  return (
    head +
    (AUTOSTART_FAIL_HINTS[motivo] ??
      'algo falló al registrar las tareas. Repite el comando; si vuelve a fallar, ejecuta pa doctor para ver qué falta.')
  );
}

function windowsExe(...parts: string[]): string {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', ...parts);
}

export interface AutostartOptions {
  stateDir?: string;
  /** Ruta de dist/cli.js para la tarea del vigilante. */
  cliJs?: string;
  /** Arranque del PC (ms epoch); por defecto, ahora menos el uptime. */
  bootAt?: number;
  /** Estado del daemon; por defecto, el pid y su proceso. */
  daemonState?: () => DaemonRunState;
  /** Lanza `pa autoupdate aplicar` aparte; por defecto, un proceso desligado. */
  launchAutoupdate?: (exe: string, args: string[]) => void;
}

/** `pa autostart vigilar`: lo que hace la tarea del vigilante cada 5 minutos. */
async function vigilar(stateDir: string, opts: AutostartOptions): Promise<number> {
  const decision = watchdogDecide({
    enabled: watchdogEnabled(),
    state: (opts.daemonState ?? (() => daemonRunState(stateDir)))(),
    stoppedAt: readStoppedOnPurpose(stateDir),
    updating: lockHeld(stateDir),
    bootAt: opts.bootAt ?? Date.now() - uptime() * 1000,
    daemonStartedAt: readDaemonStartedAt(stateDir),
  });
  let text = describeDecision(decision);
  if (decision.action === 'start') {
    const r = await runExe(
      windowsExe('WindowsPowerShell', 'v1.0', 'powershell.exe'),
      startDaemonTaskArgs(),
    );
    if (r.error) text = describeDecision({ action: 'start-failed' });
  }
  if (decision.action === 'skip' && decision.reason === 'en-marcha') {
    // Corre aparte: la tarea del vigilante tiene 2 min y compilar puede tardar más.
    const cliJs = opts.cliJs ?? join(autostartRepo(), 'dist', 'cli.js');
    if (maybeLaunchAutoupdate(stateDir, cliJs, opts.launchAutoupdate)) {
      text += '; miro si hay novedades en main';
    }
  }
  saveWatchdogLast(stateDir, text);
  process.stdout.write(`Vigilante: ${text}\n`);
  return 0;
}

async function installWatchdog(stateDir: string, cliJs: string): Promise<void> {
  const xmlPath = join(tmpdir(), `asistenta-vigilante-${process.pid}.xml`);
  // schtasks lee el XML en UTF-16 con BOM, como lo exporta el propio Programador de tareas.
  writeFileSync(
    xmlPath,
    Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(watchdogTaskXml({ nodeExe: process.execPath, cliJs }), 'utf16le'),
    ]),
  );
  try {
    const r = await runExe(windowsExe('schtasks.exe'), schtasksArgs.create(xmlPath));
    process.stdout.write(
      r.error
        ? 'Vigilante: no pude registrarlo; Asistenta arranca igual al iniciar sesión.\n'
        : `Vigilante: registrado (al iniciar sesión y cada ${WATCHDOG_INTERVAL_MIN} min la vuelve a arrancar si no está en marcha).\n`,
    );
  } finally {
    rmSync(xmlPath, { force: true });
  }
  void stateDir;
}

async function watchdogStatus(stateDir: string): Promise<void> {
  const r = await runExe(windowsExe('schtasks.exe'), schtasksArgs.query());
  const installed = !r.error;
  const off = watchdogEnabled() ? '' : ' (PA_WATCHDOG=0: no hace nada)';
  let line = installed
    ? `Vigilante: instalado, cada ${WATCHDOG_INTERVAL_MIN} min y al iniciar sesión${off}.`
    : 'Vigilante: no instalado (pa autostart install lo registra).';
  const last = readWatchdogLast(stateDir);
  if (last) line += watchdogLastLine(last, Date.now());
  process.stdout.write(`${line}\n${autoupdateStatusLine(stateDir)}\n`);
}

export async function autostartCommand(
  args: string[],
  opts: AutostartOptions = {},
): Promise<number> {
  if (process.platform !== 'win32') {
    process.stderr.write('Autoarranque completo disponible solo en Windows.\n');
    return 2;
  }
  const action = args[0] ?? 'status';
  if (
    !['install', 'status', 'uninstall', 'vigilar'].includes(action) ||
    (action === 'vigilar' && args.length > 1) ||
    args.slice(1).some((a) => !['--start', '--what-if', '--no-local-llm'].includes(a))
  ) {
    process.stderr.write(
      'uso: pa autostart install|status|uninstall [--start] [--what-if] [--no-local-llm]\n',
    );
    return 2;
  }
  const stateDir = opts.stateDir ?? paths.state;
  if (action === 'vigilar') return vigilar(stateDir, opts);
  if (action === 'status') {
    const rec = readStartupRecord(join(stateDir, STARTUP_RECORD_FILE));
    process.stdout.write(`${formatStartupRecord(rec)}\n`);
    const aviso = readBootNoticeResult(join(stateDir, BOOT_NOTICE_FILE));
    process.stdout.write(`${formatBootNoticeResult(aviso)}\n`);
  }
  const repo = autostartRepo();
  const flags = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    join(repo, 'deploy', 'windows', 'install-all.ps1'),
    '-Action',
    action,
    '-RepoDir',
    repo,
    '-NodeExe',
    process.execPath,
  ];
  // Switch is a literal PowerShell argument, not shell text. The installer defaults local LLM on.
  if (args.includes('--no-local-llm')) flags.push('-DisableLocalLlm');
  if (args.includes('--start')) flags.push('-Start');
  if (args.includes('--what-if')) flags.push('-WhatIf');
  const whatIf = args.includes('--what-if');
  if (action === 'uninstall' && !whatIf) {
    // Primero el vigilante: si no, entre que el instalador para Asistenta y quita su
    // tarea, el vigilante podría volver a arrancarla. Sin comprobar antes: si no
    // existía, schtasks falla y no pasa nada.
    await runExe(windowsExe('schtasks.exe'), schtasksArgs.remove());
  }
  const r = await runExe(windowsExe('WindowsPowerShell', 'v1.0', 'powershell.exe'), flags);
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.error) {
    process.stderr.write(`${autostartFailureMessage(r.error, r.stderr)}\n`);
    return 1;
  }
  // --start la deja encendida a propósito: igual que `pa iniciar`, quita la marca de
  // `pa stop` para que el vigilante vuelva a levantarla si se cae antes de reiniciar.
  if (action === 'install' && !whatIf && args.includes('--start')) {
    clearStoppedOnPurpose(stateDir);
  }
  if (action === 'install' && !whatIf && watchdogEnabled()) {
    await installWatchdog(stateDir, opts.cliJs ?? join(repo, 'dist', 'cli.js'));
  }
  if (whatIf && action === 'install' && watchdogEnabled()) {
    process.stdout.write(
      `Vigilante: también se registraría (al iniciar sesión y cada ${WATCHDOG_INTERVAL_MIN} min).\n`,
    );
  }
  if (whatIf && action === 'uninstall') {
    process.stdout.write('Vigilante: también se quitaría.\n');
  }
  if (action === 'status') await watchdogStatus(stateDir);
  return 0;
}

export const SUPERVISOR_MESSAGES = {
  restart:
    'Asistenta: latido detenido más de 120 s. El supervisor externo solicita cierre limpio y reinicio de la tarea. Máximo 3 intentos en 15 min.',
  forced:
    'Asistenta: el cierre limpio no terminó a tiempo. Se terminó solo el proceso propio del launcher. No se declara cierre limpio; revisa pa autostart status y los logs locales.',
  blocked:
    'Asistenta: agotados 3 reinicios del supervisor en 15 min. No forzaré otro. Revisa pa autostart status.',
  supervisor:
    'Asistenta: el supervisor externo no pudo completar una comprobación o guardar su presupuesto. No forzaré un reinicio ni declararé cierre limpio. Revisa pa autostart status y los logs locales.',
  heartbeat:
    'Asistenta: no puedo verificar un latido válido de esta instancia. No termino ningún proceso; revisa pa autostart status.',
} as const;

/** No chat history or group fallback: only the configured owner who is also allowlisted. */
export async function notifyAutostart(
  event: string,
  deps = { unlock, get: vaultGet, fetch: globalThis.fetch },
): Promise<number> {
  if (!(event in SUPERVISOR_MESSAGES) || !Object.hasOwn(SUPERVISOR_MESSAGES, event)) return 2;
  const text = SUPERVISOR_MESSAGES[event as keyof typeof SUPERVISOR_MESSAGES];
  return (await sendOwnerTelegram(text, deps)) ? 0 : 1;
}

export async function localLlmHealthy(fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetcher('http://127.0.0.1:4096/global/health', {
      signal: AbortSignal.timeout(2000),
    });
    const data: unknown = await response.json();
    return (
      response.ok &&
      data !== null &&
      typeof data === 'object' &&
      'healthy' in data &&
      data.healthy === true &&
      'version' in data &&
      typeof data.version === 'string'
    );
  } catch {
    return false;
  }
}
