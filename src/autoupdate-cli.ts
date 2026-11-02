/**
 * `pa autoupdate status|now|off|on` y lo que la conecta con Windows: git y npm de verdad,
 * el cierre limpio del daemon, la tarea del daemon que usa el vigilante y el aviso por
 * Telegram al dueño. La lógica está en autoupdate.ts; aquí solo se enchufa.
 */
import { execFile, spawn } from 'node:child_process';
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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
  type Outcome,
  readAutoupdateState,
  runAutoupdate,
  writeAutoupdateState,
} from './autoupdate.js';
import {
  UPDATE_NOT_WINDOWS,
  type UpdateButton,
  updateButtons,
  updateOffText,
} from './autoupdate-boton.js';
import { stopDaemon } from './daemon-control.js';
import { daemonStatus } from './daemon-status.js';
import { readBusy } from './ocupada.js';
import { sameProcessAsRecorded } from './process-identity.js';
import { futureDated, span, withPeriod } from './startup-record.js';
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
  buttons: UpdateButton[] = [],
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
      body: JSON.stringify({
        chat_id: owner,
        text,
        ...(buttons.length
          ? {
              reply_markup: {
                inline_keyboard: [buttons.map((b) => ({ text: b.label, callback_data: b.action }))],
              },
            }
          : {}),
      }),
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

/** Los últimos 64 KB de un log, o null si no se puede leer. */
export function readLogTail(file: string, max = 64 * 1024): string | null {
  try {
    const size = statSync(file).size;
    const len = Math.min(size, max);
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

export function realAutoupdateDeps(
  repo: string,
  stateDir: string,
  send: typeof sendOwnerTelegram = sendOwnerTelegram,
): AutoupdateDeps {
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
    launcherLog: () => readLogTail(join(stateDir, 'log', 'launcher.stderr.log')),
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
    // Todo aviso (actualizada, fallo, a medias) lleva «🔄 Buscar actualización ahora».
    notify: async (text) => {
      await send(text, undefined, updateButtons());
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
    const future = Number.isNaN(at) ? undefined : futureDated(at, now);
    const when = Number.isNaN(at) ? '? min' : span(Math.max(0, Math.round((now - at) / 60_000)));
    line += future
      ? ` Última (${future}): ${withPeriod(state.last.text)}`
      : ` Última (hace ${when}): ${withPeriod(state.last.text)}`;
  }
  if (state.pending) line += lockHeld(stateDir, now) ? AUTOUPDATE_PENDING_BUSY : AUTOUPDATE_PENDING;
  return line;
}

/** Una actualización cortada (apagón, suspensión) que aún no se ha arreglado. */
export const AUTOUPDATE_PENDING =
  ' Hay una actualización a medias (se cortó antes de acabar): la arreglo sola en la próxima revisión del vigilante, o ya mismo con pa autoupdate now.';
export const AUTOUPDATE_PENDING_BUSY =
  ' Ahora mismo estoy arreglando una actualización que se quedó a medias.';

/** Desde el vigilante: si toca revisar, lanza `pa autoupdate aplicar` aparte y vuelve. */
export function maybeLaunchAutoupdate(
  stateDir: string,
  cliJs: string,
  launch: (exe: string, args: string[]) => void = (exe, args) =>
    spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref(),
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): boolean {
  if (lockHeld(stateDir, now)) return false;
  const state = readAutoupdateState(stateDir);
  // Una actualización a medias se arregla ya, aunque esté apagada o no toque revisar:
  // si no, Asistenta seguía con la versión a medio montar hasta 30 min (o para siempre).
  if (!state.pending) {
    if (!autoupdateEnabled(stateDir, env)) return false;
    if (!autoupdateDue(state, now, autoupdateIntervalMin(env))) return false;
  }
  try {
    launch(process.execPath, [cliJs, 'autoupdate', 'aplicar']);
    return true;
  } catch {
    return false;
  }
}

/** Orden mal escrita: qué hace cada una, sin la notación «uso: a|b». */
/** Fuera de Windows: cómo actualizar a mano, no solo «no se puede». */
export const AUTOUPDATE_NOT_WINDOWS = UPDATE_NOT_WINDOWS;

export const AUTOUPDATE_USAGE =
  'No conozco esa orden. Usa: pa autoupdate status (cómo está), pa autoupdate now (actualizar ya), pa autoupdate off (que no se actualice sola) o pa autoupdate on (que vuelva a hacerlo).';

/** Lo que contesta el botón cuando la revisión no mandó ya su propio aviso. */
export function buttonOutcomeText(
  out: Outcome,
  opts: { version?: string; offText?: string | null } = {},
): string {
  if (out.kind === 'al-dia') {
    const commit = /\(([0-9a-f]{7,})\)/.exec(out.text)?.[1];
    const which = [opts.version, commit && (opts.version ? `(${commit})` : commit)]
      .filter(Boolean)
      .join(' ');
    return `✅ Ya tienes la última versión${which ? `: ${which}` : ''}. No hay nada nuevo.`;
  }
  if (out.kind === 'actualizada') return `✅ Actualizada: ${withPeriod(out.text)}`;
  if (out.kind === 'aplazada') {
    return `⏸️ Todavía no me actualizo: ${withPeriod(out.text)} Vuelve a pulsar el botón cuando acabe.`;
  }
  if (opts.offText && out.text === 'autoactualización apagada') return opts.offText;
  return `⚠️ No me he actualizado: ${withPeriod(out.text)}`;
}

/** La versión de package.json, o undefined si no se puede leer. */
function packageVersion(repo: string): string | undefined {
  try {
    const v = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `pa autoupdate boton`, lo que lanza el botón de Telegram: la revisión de `now` y una
 * respuesta en el chat siempre (al día con la versión, «me actualizo» antes de parar,
 * y el error o el motivo si no se actualiza). El aviso de éxito o de fallo es el de
 * siempre; si la revisión ya avisó, no se repite.
 */
async function autoupdateButtonRun(
  stateDir: string,
  deps: AutoupdateDeps,
  env: NodeJS.ProcessEnv,
  version: string | undefined,
): Promise<Outcome> {
  let notified = false;
  const tracked: AutoupdateDeps = {
    ...deps,
    notify: async (text) => {
      notified = true;
      await deps.notify(text);
    },
  };
  let out: Outcome;
  try {
    out = await runAutoupdate(stateDir, tracked, {
      force: true,
      env,
      onUpdating: ({ from, to, changes }) =>
        deps.notify(
          `🔄 Hay una versión nueva (${from.slice(0, 7)} → ${to.slice(0, 7)}, ${changes} ${changes === 1 ? 'cambio' : 'cambios'}). Me actualizo ahora: me cierro un momento y te aviso aquí cuando vuelva.`,
        ),
    });
  } catch (err) {
    out = {
      kind: 'error',
      text: `algo falló al buscar (${String((err as Error)?.message ?? err)})`,
    };
  }
  if (!notified) {
    await deps
      .notify(buttonOutcomeText(out, { version, offText: updateOffText(stateDir, env) }))
      .catch(() => {});
  }
  return out;
}

export async function autoupdateCommand(
  args: string[],
  opts: {
    stateDir: string;
    repo: string;
    deps?: AutoupdateDeps;
    env?: NodeJS.ProcessEnv;
    /** Solo tests: la versión que diría package.json. */
    version?: string;
  },
): Promise<number> {
  const action = args[0] ?? 'status';
  // `aplicar` (vigilante) y `boton` (Telegram) son internas: no salen en la ayuda.
  if (args.length > 1 || !['status', 'now', 'off', 'on', 'aplicar', 'boton'].includes(action)) {
    process.stderr.write(`${AUTOUPDATE_USAGE}\n`);
    return 2;
  }
  const { stateDir, env = process.env } = opts;
  if (action === 'off' || action === 'on') {
    writeAutoupdateState(stateDir, { ...readAutoupdateState(stateDir), off: action === 'off' });
  }
  if (action === 'now' || action === 'aplicar' || action === 'boton') {
    if (process.platform !== 'win32' && !opts.deps) {
      process.stderr.write(`${AUTOUPDATE_NOT_WINDOWS}\n`);
      return 2;
    }
    const deps = opts.deps ?? realAutoupdateDeps(opts.repo, stateDir);
    const out =
      action === 'boton'
        ? await autoupdateButtonRun(stateDir, deps, env, opts.version ?? packageVersion(opts.repo))
        : await runAutoupdate(stateDir, deps, { force: action === 'now', env });
    process.stdout.write(`Autoactualización: ${out.text}\n`);
    return out.kind === 'revertida' || out.kind === 'error' ? 1 : 0;
  }
  process.stdout.write(`${autoupdateStatusLine(stateDir, env)}\n`);
  return 0;
}
