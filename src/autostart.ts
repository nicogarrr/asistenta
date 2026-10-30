import { execFile } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir, uptime } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type DaemonRunState,
  describeDecision,
  readStoppedOnPurpose,
  readWatchdogLast,
  saveWatchdogLast,
  schtasksArgs,
  startDaemonTaskArgs,
  WATCHDOG_INTERVAL_MIN,
  watchdogDecide,
  watchdogEnabled,
  watchdogTaskXml,
} from './autostart-watchdog.js';
import { daemonStatus } from './daemon-status.js';
import { paths } from './paths.js';
import { formatStartupRecord, readStartupRecord, STARTUP_RECORD_FILE } from './startup-record.js';
import { unlock, vaultGet } from './vault.js';
import { resolveOwnerUserId } from './vigilante.js';

export function autostartRepo(moduleUrl: string = import.meta.url): string {
  return fileURLToPath(new URL('..', moduleUrl));
}

type ExecResult = { error: Error | null; stdout: string };

function runExe(exe: string, flags: string[], timeout = 120_000): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    execFile(exe, flags, { windowsHide: true, timeout, maxBuffer: 64 * 1024 }, (error, stdout) =>
      resolve({ error: error ?? null, stdout: String(stdout ?? '') }),
    );
  });
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
}

function realDaemonState(stateDir: string): DaemonRunState {
  const r = daemonStatus({ stateDir }) as { pidState?: string; processState?: string };
  if (r.pidState === 'missing' || r.processState === 'dead') return 'stopped';
  if (r.pidState === 'valid' && r.processState === 'alive') return 'running';
  return 'unknown';
}

/** `pa autostart vigilar`: lo que hace la tarea del vigilante cada 5 minutos. */
async function vigilar(stateDir: string, opts: AutostartOptions): Promise<number> {
  const decision = watchdogDecide({
    enabled: watchdogEnabled(),
    state: (opts.daemonState ?? (() => realDaemonState(stateDir)))(),
    stoppedAt: readStoppedOnPurpose(stateDir),
    bootAt: opts.bootAt ?? Date.now() - uptime() * 1000,
  });
  let text = describeDecision(decision);
  if (decision.action === 'start') {
    const r = await runExe(
      windowsExe('WindowsPowerShell', 'v1.0', 'powershell.exe'),
      startDaemonTaskArgs(),
    );
    if (r.error) text = describeDecision({ action: 'start-failed' });
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
  if (last) {
    const min = Math.max(0, Math.round((Date.now() - last.at) / 60_000));
    line += ` Última revisión hace ${min} min: ${last.text}.`;
  }
  process.stdout.write(`${line}\n`);
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
  const r = await runExe(windowsExe('WindowsPowerShell', 'v1.0', 'powershell.exe'), flags);
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.error) {
    process.stderr.write('Autoarranque no completado; revisa requisitos y permisos locales.\n');
    return 1;
  }
  const whatIf = args.includes('--what-if');
  if (action === 'install' && !whatIf && watchdogEnabled()) {
    await installWatchdog(stateDir, opts.cliJs ?? join(repo, 'dist', 'cli.js'));
  }
  if (action === 'uninstall' && !whatIf) {
    // Sin comprobar antes: si no existía, schtasks falla y no pasa nada.
    await runExe(windowsExe('schtasks.exe'), schtasksArgs.remove());
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
  try {
    await deps.unlock();
    const allowed =
      (await deps.get('telegram:allowedUserIds'))
        ?.split(',')
        .map(Number)
        .filter((n) => Number.isSafeInteger(n) && n > 0) ?? [];
    const explicit = Number(await deps.get('vigilante:ownerUserId'));
    const owner = resolveOwnerUserId(
      allowed,
      Number.isSafeInteger(explicit) && explicit > 0 ? explicit : null,
    );
    const token = await deps.get('telegram:botToken');
    if (!owner || !allowed.includes(owner) || !token) return 1;
    const response = await deps.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      signal: AbortSignal.timeout(8000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: owner,
        text: SUPERVISOR_MESSAGES[event as keyof typeof SUPERVISOR_MESSAGES],
      }),
    });
    const data: unknown = await response.json();
    return response.ok &&
      data !== null &&
      typeof data === 'object' &&
      'ok' in data &&
      data.ok === true
      ? 0
      : 1;
  } catch {
    return 1;
  }
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
