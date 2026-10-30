/**
 * Vigilante del arranque automático en Windows (PA_WATCHDOG, encendido por defecto).
 *
 * `pa autostart install` registra además una tarea programada que corre cada 5 minutos
 * y al iniciar sesión: `pa autostart vigilar`. Si el daemon no está en marcha, arranca la
 * tarea normal del daemon (la misma que lanza el inicio de sesión), así que nunca hay dos
 * copias: esa tarea no abre otra instancia si ya corre, y el propio daemon tiene su pid.
 * Ante la duda (no se puede saber si corre) no hace nada.
 *
 * Si Nico paró Asistenta a propósito (`pa stop`), el vigilante la deja apagada hasta el
 * próximo arranque del PC o hasta `pa iniciar`.
 *
 * Todo lo que se le pasa a Windows sale de funciones puras de este fichero (tests sin
 * ejecutar nada de verdad).
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, win32 } from 'node:path';

export const WATCHDOG_TASK_NAME = 'Asistenta-vigilante';
export const WATCHDOG_INTERVAL_MIN = 5;
export const STOPPED_ON_PURPOSE_FILE = 'parado-a-proposito.json';
export const WATCHDOG_LAST_FILE = 'vigilante.json';
/** Nombre de la tarea del daemon que registra deploy/windows/install-all.ps1. */
export const DAEMON_TASK_NAME = 'personal-agent-daemon';

export function watchdogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.PA_WATCHDOG ?? '').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(v);
}

const xmlEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Comando que lanza la tarea: PowerShell oculto que ejecuta `node <cli> autostart vigilar`. */
export function watchdogCommand(nodeExe: string, cliJs: string, systemRoot = 'C:\\Windows') {
  const ps = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  return {
    command: ps,
    arguments: `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "& ${q(nodeExe)} ${q(cliJs)} autostart vigilar"`,
  };
}

/** XML de la tarea: al iniciar sesión y cada 5 min, una sola instancia, sin privilegios. */
export function watchdogTaskXml(opts: { nodeExe: string; cliJs: string; systemRoot?: string }) {
  const { command, arguments: args } = watchdogCommand(opts.nodeExe, opts.cliJs, opts.systemRoot);
  // Sin carpeta de trabajo la tarea corre en System32 y el CLI no lee el `.env` del repo
  // (PA_WATCHDOG=0, PA_STATE_DIR…): igual que la tarea del daemon, arranca en la raíz del repo.
  const repoDir = win32.dirname(win32.dirname(opts.cliJs));
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Asistenta: si no está en marcha (y no la paraste tú), la vuelve a arrancar. PA_WATCHDOG=0 lo apaga.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <Delay>PT1M</Delay>
    </LogonTrigger>
    <TimeTrigger>
      <Enabled>true</Enabled>
      <StartBoundary>2026-01-01T00:00:00</StartBoundary>
      <Repetition>
        <Interval>PT${WATCHDOG_INTERVAL_MIN}M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT2M</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(command)}</Command>
      <Arguments>${xmlEscape(args)}</Arguments>
      <WorkingDirectory>${xmlEscape(repoDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** Argumentos de schtasks.exe para cada paso (nunca por shell). */
export const schtasksArgs = {
  create: (xmlPath: string) => ['/Create', '/F', '/TN', WATCHDOG_TASK_NAME, '/XML', xmlPath],
  remove: () => ['/Delete', '/F', '/TN', WATCHDOG_TASK_NAME],
  query: () => ['/Query', '/TN', WATCHDOG_TASK_NAME, '/FO', 'LIST'],
};

/** PowerShell que arranca la tarea del daemon por su nombre (esté en la carpeta que esté). */
export function startDaemonTaskArgs(): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `Get-ScheduledTask -TaskName '${DAEMON_TASK_NAME}' -ErrorAction Stop | Start-ScheduledTask`,
  ];
}

export type DaemonRunState = 'running' | 'stopped' | 'unknown';

export type WatchdogDecision =
  | { action: 'start' }
  | {
      action: 'skip';
      reason: 'apagado' | 'en-marcha' | 'dudoso' | 'parado-a-proposito' | 'actualizando';
    };

export function watchdogDecide(input: {
  enabled: boolean;
  state: DaemonRunState;
  /** ms epoch de `pa stop`, si lo hubo. */
  stoppedAt?: number;
  /** ms epoch del último arranque del PC. */
  bootAt: number;
  /** Una autoactualización tiene el daemon parado a propósito mientras compila. */
  updating?: boolean;
}): WatchdogDecision {
  if (!input.enabled) return { action: 'skip', reason: 'apagado' };
  if (input.updating) return { action: 'skip', reason: 'actualizando' };
  if (input.state === 'running') return { action: 'skip', reason: 'en-marcha' };
  if (input.state === 'unknown') return { action: 'skip', reason: 'dudoso' };
  if (input.stoppedAt !== undefined && input.stoppedAt >= input.bootAt) {
    return { action: 'skip', reason: 'parado-a-proposito' };
  }
  return { action: 'start' };
}

export function describeDecision(d: WatchdogDecision | { action: 'start-failed' }): string {
  if (d.action === 'start') return 'no estaba en marcha: la arranqué';
  if (d.action === 'start-failed') return 'no estaba en marcha y no pude arrancarla';
  return {
    apagado: 'vigilante apagado (PA_WATCHDOG=0)',
    'en-marcha': 'en marcha',
    dudoso: 'no sé si corre: no toco nada',
    'parado-a-proposito': 'la paraste tú: sigue apagada hasta reiniciar el PC o pa iniciar',
    actualizando: 'se está actualizando: no la toco',
  }[d.reason];
}

function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

function readAt(path: string): number | undefined {
  try {
    const at = (JSON.parse(readFileSync(path, 'utf8')) as { at?: unknown }).at;
    const ms = typeof at === 'string' ? Date.parse(at) : Number.NaN;
    return Number.isNaN(ms) ? undefined : ms;
  } catch {
    return undefined;
  }
}

/** `pa stop` lo marca; el vigilante lo respeta hasta el próximo arranque del PC. */
export function markStoppedOnPurpose(stateDir: string, now: Date = new Date()): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeJson(join(stateDir, STOPPED_ON_PURPOSE_FILE), { at: now.toISOString() });
  } catch {
    // Si no se puede marcar, el vigilante la volverá a arrancar: mejor eso que romper pa stop.
  }
}

/** `pa iniciar` lo quita: Nico la quiere encendida otra vez. */
export function clearStoppedOnPurpose(stateDir: string): void {
  rmSync(join(stateDir, STOPPED_ON_PURPOSE_FILE), { force: true });
}

export function readStoppedOnPurpose(stateDir: string): number | undefined {
  return readAt(join(stateDir, STOPPED_ON_PURPOSE_FILE));
}

export function saveWatchdogLast(stateDir: string, text: string, now: Date = new Date()): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeJson(join(stateDir, WATCHDOG_LAST_FILE), { at: now.toISOString(), text });
  } catch {
    // Solo es un diagnóstico.
  }
}

export function readWatchdogLast(stateDir: string): { at: number; text: string } | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(stateDir, WATCHDOG_LAST_FILE), 'utf8')) as {
      at?: unknown;
      text?: unknown;
    };
    const at = typeof raw.at === 'string' ? Date.parse(raw.at) : Number.NaN;
    if (Number.isNaN(at) || typeof raw.text !== 'string') return undefined;
    return { at, text: raw.text };
  } catch {
    return undefined;
  }
}
