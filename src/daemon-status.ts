import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './paths.js';
import { readHeartbeat, staleThresholdMs } from './watchdog.js';

export interface DaemonStatusDeps {
  stateDir?: string;
  now?: () => number;
  probe?: (pid: number) => 'alive' | 'dead' | 'unknown';
}

function probeProcess(pid: number): 'alive' | 'dead' | 'unknown' {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    // Missing process is evidence of death. Permission/platform failures are not.
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown';
  }
}

export function daemonStatus(deps: DaemonStatusDeps = {}) {
  const dir = deps.stateDir ?? paths.state;
  const pidFile = join(dir, 'agent.pid');
  const heartbeatFile = join(dir, 'agent.heartbeat');
  let pid: number | null = null;
  let pidState: 'missing' | 'invalid' | 'unreadable' | 'valid' = 'missing';
  try {
    const raw = readFileSync(pidFile, 'utf8').trim();
    const value = Number(raw);
    if (/^[1-9]\d*$/.test(raw) && Number.isSafeInteger(value)) {
      pid = value;
      pidState = 'valid';
    } else {
      pidState = 'invalid';
    }
  } catch (error) {
    pidState = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
  }
  let processState: 'alive' | 'dead' | 'unknown' = 'unknown';
  if (pid !== null) {
    try {
      processState = (deps.probe ?? probeProcess)(pid);
    } catch {
      processState = 'unknown';
    }
  }
  const now = (deps.now ?? Date.now)();
  const beat = readHeartbeat(heartbeatFile);
  const ageMs = beat.at === null ? null : now - beat.at;
  const staleAfterMs = staleThresholdMs();
  const heartbeatState =
    ageMs === null ? 'missing' : ageMs < 0 ? 'future' : ageMs >= staleAfterMs ? 'stale' : 'fresh';
  return {
    pid,
    pidState,
    processState,
    heartbeatState,
    ageMs,
    staleAfterMs,
    pidFile,
    heartbeatFile,
    supervisionInstalled: null,
  };
}

export function statusCommand(
  args: string[],
  deps: DaemonStatusDeps = {},
  write: (text: string) => void = (text) => {
    process.stdout.write(text);
  },
  error: (text: string) => void = (text) => {
    process.stderr.write(text);
  },
): number {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
    error('uso: pa status [--json]\n');
    return 2;
  }
  const report = daemonStatus(deps);
  if (args[0] === '--json') {
    write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const pidText =
      report.pid === null
        ? `PID no disponible (${report.pidState}).`
        : `PID ${report.pid}: ${report.processState === 'alive' ? 'el proceso existe' : report.processState === 'dead' ? 'el proceso no existe' : 'no se pudo comprobar el proceso'}.`;
    const beatText =
      report.heartbeatState === 'fresh'
        ? `Latido reciente: hace ${Math.floor((report.ageMs ?? 0) / 1000)} s.`
        : report.heartbeatState === 'stale'
          ? `Latido atrasado: hace ${Math.floor((report.ageMs ?? 0) / 1000)} s.`
          : report.heartbeatState === 'future'
            ? 'Latido con fecha futura: revisar el reloj; no prueba salud.'
            : 'No hay latido legible.';
    write(
      `${pidText}\n${beatText}\nUmbral de latido: ${report.staleAfterMs / 1000} s.\nUn PID vivo y un latido reciente no prueban que Telegram o el LLM funcionen.\nConsulta puntual: no vigila, no inicia ni reinicia el daemon; no comprueba si hay supervisor instalado.\nPID: ${report.pidFile}\nLatido: ${report.heartbeatFile}\n`,
    );
  }
  return 0;
}
