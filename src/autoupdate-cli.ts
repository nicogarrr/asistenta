/**
 * `pa autoupdate status|now|off|on` y lo que la conecta con Windows: git y npm de verdad,
 * el cierre limpio del daemon, la tarea del daemon que usa el vigilante y el aviso por
 * Telegram al dueño. La lógica está en autoupdate.ts; aquí solo se enchufa.
 */
import { execFile, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type DaemonRunState, startDaemonTaskArgs } from './autostart-watchdog.js';
import {
  AUTOUPDATE_DIR,
  type AutoupdateDeps,
  autoupdateDue,
  autoupdateEnabled,
  autoupdateEnvEnabled,
  autoupdateIntervalMin,
  type CmdResult,
  lockHeld,
  readAutoupdateState,
  runAutoupdate,
  writeAutoupdateState,
} from './autoupdate.js';
import { stopDaemon } from './daemon-control.js';
import { daemonStatus } from './daemon-status.js';
import { readBusy } from './ocupada.js';
import { sameProcessAsRecorded } from './process-identity.js';
import { unlock as unlockVault, vaultGet } from './vault.js';
import { resolveOwnerUserId } from './vigilante.js';

export function runExe(
  exe: string,
  flags: string[],
  timeout = 120_000,
  cwd?: string,
): Promise<{ error: Error | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      exe,
      flags,
      { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024, cwd },
      (error, stdout, stderr) =>
        resolve({
          error: error ?? null,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        }),
    );
  });
}

export function windowsExe(...parts: string[]): string {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', ...parts);
}

export function daemonRunState(
  stateDir: string,
  deps: {
    probe?: (pid: number) => 'alive' | 'dead' | 'unknown';
    identityOf?: (pid: number) => string | null;
  } = {},
): DaemonRunState {
  const r = daemonStatus({ stateDir, probe: deps.probe }) as {
    pid?: number | null;
    pidState?: string;
    processState?: string;
    heartbeatState?: string;
  };
  if (r.pidState === 'missing' || r.processState === 'dead') return 'stopped';
  // agent.pid vacío o a medias (un corte de luz a mitad de escritura) y sin latido
  // reciente: nadie la está moviendo. Antes quedaba «dudoso» y nunca se relanzaba.
  if (r.pidState === 'invalid' && (r.heartbeatState === 'stale' || r.heartbeatState === 'missing'))
    return 'stopped';
  if (r.pidState === 'valid' && r.processState === 'alive') {
    // Tras un cuelgue el pid queda en agent.pid y Windows lo reutiliza pronto: si el
    // proceso vivo no es el que arrancó Asistenta (agent.pid.start), no está en marcha.
    if (
      typeof r.pid === 'number' &&
      sameProcessAsRecorded(join(stateDir, 'agent.pid.start'), r.pid, deps.identityOf) ===
        'different'
    ) {
      return 'stopped';
    }
    return 'running';
  }
  return 'unknown';
}

/** Arranca la tarea del daemon por su nombre: el mismo camino que el vigilante. */
export async function startDaemonTask(): Promise<boolean> {
  const r = await runExe(
    windowsExe('WindowsPowerShell', 'v1.0', 'powershell.exe'),
    startDaemonTaskArgs(),
  );
  return !r.error;
}

/** Texto al chat privado del dueño (el mismo camino que los avisos del supervisor). */
export async function sendOwnerTelegram(
  text: string,
  deps = { unlock: unlockVault, get: vaultGet, fetch: globalThis.fetch },
): Promise<boolean> {
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
    if (!owner || !allowed.includes(owner) || !token) return false;
    const response = await deps.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      signal: AbortSignal.timeout(8000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: owner, text }),
    });
    const data: unknown = await response.json();
    return (
      response.ok && data !== null && typeof data === 'object' && 'ok' in data && data.ok === true
    );
  } catch {
    return false;
  }
}

/** npm sin shell: el npm-cli.js que viene con este node (npm.cmd no se lanza sin shell). */
function npmInvocation(args: string[]): [string, string[]] {
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return existsSync(cli) ? [process.execPath, [cli, ...args]] : ['npm', args];
}

export function realAutoupdateDeps(repo: string, stateDir: string): AutoupdateDeps {
  const run = async (exe: string, args: string[], timeout = 120_000): Promise<CmdResult> => {
    const r = await runExe(exe, args, timeout, repo);
    const code = r.error ? Number((r.error as { code?: unknown }).code) || 1 : 0;
    return { code, out: `${r.stdout}${r.stderr}` };
  };
  const dist = join(repo, 'dist');
  const prev = join(repo, 'dist.anterior');
  return {
    git: (args, t) => run('git', args, t),
    npm: (args, t) => run(...npmInvocation(args), t),
    daemonState: () => daemonRunState(stateDir),
    busy: () => readBusy(stateDir),
    stopDaemon: async () => {
      await stopDaemon(stateDir);
    },
    startDaemon: startDaemonTask,
    backupDist: () => {
      rmSync(prev, { recursive: true, force: true });
      if (existsSync(dist)) cpSync(dist, prev, { recursive: true });
    },
    restoreDist: () => {
      if (!existsSync(prev)) return;
      rmSync(dist, { recursive: true, force: true });
      renameSync(prev, dist);
    },
    dropBackup: () => rmSync(prev, { recursive: true, force: true }),
    notify: async (text) => {
      await sendOwnerTelegram(text);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    log: (text) => {
      try {
        mkdirSync(join(stateDir, AUTOUPDATE_DIR), { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        writeFileSync(join(stateDir, AUTOUPDATE_DIR, `${stamp}.log`), text);
      } catch {
        // Solo diagnóstico.
      }
    },
  };
}

/** Una línea para `pa autoupdate status` y `pa autostart status`. */
export function autoupdateStatusLine(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): string {
  const state = readAutoupdateState(stateDir);
  const why = !autoupdateEnvEnabled(env) ? 'PA_AUTOUPDATE=0' : 'pa autoupdate off';
  let line = autoupdateEnabled(stateDir, env)
    ? `Autoactualización: encendida, revisa main cada ${autoupdateIntervalMin(env)} min.`
    : `Autoactualización: apagada (${why}).`;
  if (state.last) {
    const at = Date.parse(state.last.at);
    const min = Number.isNaN(at) ? '?' : Math.max(0, Math.round((now - at) / 60_000));
    line += ` Última (hace ${min} min): ${state.last.text}.`;
  }
  return line;
}

/** Desde el vigilante: si toca revisar, lanza `pa autoupdate aplicar` aparte y vuelve. */
export function maybeLaunchAutoupdate(
  stateDir: string,
  cliJs: string,
  launch: (exe: string, args: string[]) => void = (exe, args) =>
    spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref(),
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): boolean {
  if (!autoupdateEnabled(stateDir, env) || lockHeld(stateDir, now)) return false;
  if (!autoupdateDue(readAutoupdateState(stateDir), now, autoupdateIntervalMin(env))) return false;
  try {
    launch(process.execPath, [cliJs, 'autoupdate', 'aplicar']);
    return true;
  } catch {
    return false;
  }
}

export async function autoupdateCommand(
  args: string[],
  opts: { stateDir: string; repo: string; deps?: AutoupdateDeps; env?: NodeJS.ProcessEnv },
): Promise<number> {
  const action = args[0] ?? 'status';
  if (args.length > 1 || !['status', 'now', 'off', 'on', 'aplicar'].includes(action)) {
    process.stderr.write('uso: pa autoupdate status|now|off|on\n');
    return 2;
  }
  const { stateDir, env = process.env } = opts;
  if (action === 'off' || action === 'on') {
    writeAutoupdateState(stateDir, { ...readAutoupdateState(stateDir), off: action === 'off' });
  }
  if (action === 'now' || action === 'aplicar') {
    if (process.platform !== 'win32' && !opts.deps) {
      process.stderr.write(
        'Autoactualización disponible solo en Windows (reinicia la tarea del daemon).\n',
      );
      return 2;
    }
    const out = await runAutoupdate(
      stateDir,
      opts.deps ?? realAutoupdateDeps(opts.repo, stateDir),
      {
        force: action === 'now',
        env,
      },
    );
    process.stdout.write(`Autoactualización: ${out.text}\n`);
    return out.kind === 'revertida' || out.kind === 'error' ? 1 : 0;
  }
  process.stdout.write(`${autoupdateStatusLine(stateDir, env)}\n`);
  return 0;
}
