import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './paths.js';
import { staleThresholdMs } from './watchdog.js';

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
  let heartbeatSource: 'content' | 'mtime' | 'missing' | 'invalid' = 'missing';
  let heartbeatAt: number | null = null;
  let modifiedAt: number | null = null;
  try {
    const stat = statSync(heartbeatFile);
    if (!stat.isFile()) {
      heartbeatSource = 'invalid';
    } else {
      modifiedAt = stat.mtimeMs;
      const raw = readFileSync(heartbeatFile, 'utf8').trim();
      const value = Number(raw);
      if (/^[1-9]\d*$/.test(raw) && Number.isSafeInteger(value)) {
        heartbeatSource = 'content';
        heartbeatAt = value;
      } else {
        heartbeatSource = 'mtime';
      }
    }
  } catch (error) {
    heartbeatSource = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid';
  }
  const ageMs = heartbeatAt === null ? null : now - heartbeatAt;
  const staleAfterMs = staleThresholdMs();
  const heartbeatState =
    heartbeatSource === 'missing'
      ? 'missing'
      : heartbeatSource === 'invalid'
        ? 'invalid'
        : heartbeatSource === 'mtime'
          ? 'unverified'
          : ageMs !== null && ageMs < 0
            ? 'future'
            : ageMs !== null && ageMs >= staleAfterMs
              ? 'stale'
              : 'fresh';
  return {
    pid,
    pidState,
    processState,
    heartbeatState,
    heartbeatSource,
    modifiedAt,
    ageMs,
    staleAfterMs,
    pidFile,
    heartbeatFile,
    supervisionInstalled: null,
  };
}

/** Sin PID legible: por qué, en castellano (antes «PID no disponible (missing)»). */
const PID_SIN_ARCHIVO = {
  missing: 'No encuentro Asistenta en marcha.',
  invalid: 'No sé si Asistenta está en marcha: el archivo que lo apunta está dañado.',
  unreadable: 'No he podido comprobar si Asistenta está en marcha (¿permisos?).',
} as const;

const segundos = (ms: number | null) => {
  const s = Math.floor((ms ?? 0) / 1000);
  return s < 120 ? `${s} s` : `${Math.floor(s / 60)} min`;
};

/** `pa status` en castellano llano: primero si está en marcha y qué hacer; luego los límites. */
function humanStatus(report: ReturnType<typeof daemonStatus>): string[] {
  const lines: string[] = [];
  const beat = report.heartbeatState;
  if (report.pid === null) {
    lines.push(PID_SIN_ARCHIVO[report.pidState as Exclude<typeof report.pidState, 'valid'>]);
    if (report.pidState === 'missing') lines.push('Para arrancarla: levantar.bat o pa iniciar.');
  } else if (report.processState === 'dead') {
    lines.push('Asistenta no está en marcha: se cerró sin avisar.');
    lines.push('Para arrancarla: levantar.bat o pa iniciar.');
  } else if (report.processState === 'unknown') {
    lines.push('No pude comprobar si Asistenta está en marcha.');
  } else if (beat === 'fresh') {
    lines.push(`Asistenta está en marcha: dio señal de vida hace ${segundos(report.ageMs)}.`);
  } else if (beat === 'stale') {
    lines.push(
      `Asistenta está abierta, pero lleva ${segundos(report.ageMs)} sin dar señal de vida: puede estar colgada.`,
    );
    lines.push('Si sigue así: pa stop y vuelve a arrancarla (levantar.bat o pa iniciar).');
  } else {
    lines.push('Asistenta está abierta, pero no puedo confirmar que responda.');
  }
  if (beat === 'future') lines.push('Su señal de vida tiene fecha futura: revisa la hora del PC.');
  else if (beat === 'unverified')
    lines.push(
      'El archivo de señal de vida cambió, pero su contenido no es verificable; no confirma que responda.',
    );
  else if (beat === 'invalid')
    lines.push('El archivo de señal de vida es inválido o ilegible; no confirma que responda.');
  else if (beat === 'missing' && report.processState === 'alive')
    lines.push('Todavía no hay señal de vida.');
  lines.push('Que esté en marcha no garantiza que Telegram y el modelo respondan (pa doctor).');
  lines.push(
    'Esto solo mira: no inicia ni reinicia nada, y no comprueba si el autoarranque está instalado (pa autostart status).',
  );
  return lines;
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
    write(`${humanStatus(report).join('\n')}\n`);
  }
  return 0;
}
