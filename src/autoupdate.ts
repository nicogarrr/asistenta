/**
 * Autoactualización (PA_AUTOUPDATE, encendida por defecto; PA_AUTOUPDATE=0 la apaga).
 *
 * El vigilante de Windows (autostart-watchdog.ts) la lanza cada PA_AUTOUPDATE_INTERVAL_MIN
 * (30 por defecto). Si origin/main va por delante, el árbol está limpio, estamos en main y
 * el avance es fast-forward, espera a que Asistenta esté libre, para el daemon, hace
 * `git merge --ff-only`, `npm ci` (solo si cambió package-lock.json) y `npm run build`, y lo
 * vuelve a arrancar por la misma tarea que usa el vigilante. Si algo falla, o el daemon no
 * vuelve sano, deja el commit y el dist de antes y avisa por Telegram.
 *
 * Nunca hace merge de verdad, nunca resetea encima de cambios locales y nunca toca otra rama.
 * Todo efecto (git, npm, daemon, Telegram) llega inyectado: los tests no ejecutan nada real.
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { DaemonRunState } from './autostart-watchdog.js';
import { writeFileReplacing } from './fs-tmp.js';
import { BUSY_DIR, type BusyState } from './ocupada.js';

export const AUTOUPDATE_DIR = BUSY_DIR;
export const AUTOUPDATE_STATE_FILE = 'estado.json';
export const AUTOUPDATE_LOCK_FILE = 'en-curso.lock';
/** Como mucho una actualización cada 30 min, aunque el intervalo de revisión sea menor. */
export const MIN_GAP_MS = 30 * 60_000;
/** Un candado más viejo que esto es de un proceso que murió. */
export const LOCK_STALE_MS = 45 * 60_000;
/**
 * Cuánto espera a que la versión nueva vuelva sana. «Sana» = el daemon escribió su
 * agent.pid, y eso pasa al FINAL del arranque (modelo, Telegram con reintentos, correo,
 * OCR, herramientas): en un PC lento, con la compilación recién hecha, 120 s no daban.
 * PA_AUTOUPDATE_SALUD_SEG lo cambia (de 60 a 600 s).
 */
export const HEALTH_TIMEOUT_MS = 300_000;

export function autoupdateHealthMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number((env.PA_AUTOUPDATE_SALUD_SEG ?? '').trim() || HEALTH_TIMEOUT_MS / 1000);
  return Number.isFinite(n) ? Math.min(600, Math.max(60, Math.round(n))) * 1000 : HEALTH_TIMEOUT_MS;
}
export const CHANGELOG_MAX = 8;
/** Una versión que ya falló al instalarse no se reintenta antes de esto (salvo pa autoupdate now). */
export const FAILED_RETRY_MS = 6 * 60 * 60_000;

const OFF = ['0', 'false', 'no', 'off'];

export function autoupdateEnvEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !OFF.includes((env.PA_AUTOUPDATE ?? '').trim().toLowerCase());
}

export function autoupdateIntervalMin(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number((env.PA_AUTOUPDATE_INTERVAL_MIN ?? '').trim() || 30);
  return Number.isFinite(n) ? Math.min(1440, Math.max(5, Math.round(n))) : 30;
}

export type OutcomeKind = 'al-dia' | 'actualizada' | 'omitida' | 'aplazada' | 'revertida' | 'error';
export interface Outcome {
  kind: OutcomeKind;
  text: string;
}
export interface AutoupdateState {
  off?: boolean;
  lastCheckAt?: string;
  lastUpdateAt?: string;
  last?: Outcome & { at: string };
  /** origin/main que falló al instalarse y cuándo: no se repite el aviso por la misma versión. */
  failedRemote?: string;
  failedAt?: string;
  /**
   * Actualización empezada y sin terminar: se escribe justo antes del `git merge` y se
   * borra al acabar (bien o con vuelta atrás). Si sigue ahí en la revisión siguiente, el
   * PC se apagó, se suspendió o se cortó a mitad: se vuelve a la versión anterior.
   */
  pending?: { from: string; to: string; at: string };
}

const dir = (stateDir: string) => join(stateDir, AUTOUPDATE_DIR);

export function readAutoupdateState(stateDir: string): AutoupdateState {
  try {
    const raw = JSON.parse(readFileSync(join(dir(stateDir), AUTOUPDATE_STATE_FILE), 'utf8'));
    return raw && typeof raw === 'object' ? (raw as AutoupdateState) : {};
  } catch {
    return {};
  }
}

export function writeAutoupdateState(stateDir: string, state: AutoupdateState): void {
  try {
    mkdirSync(dir(stateDir), { recursive: true });
    const file = join(dir(stateDir), AUTOUPDATE_STATE_FILE);
    writeFileReplacing(file, JSON.stringify(state));
  } catch {
    // Solo es diagnóstico y el interruptor on/off; sin él se usa el valor por defecto.
  }
}

export function autoupdateEnabled(stateDir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return autoupdateEnvEnabled(env) && readAutoupdateState(stateDir).off !== true;
}

/** Toca revisar: nunca se revisó o la última revisión es más vieja que el intervalo. */
export function autoupdateDue(state: AutoupdateState, now: number, intervalMin: number): boolean {
  const last = state.lastCheckAt ? Date.parse(state.lastCheckAt) : Number.NaN;
  return Number.isNaN(last) || now - last >= intervalMin * 60_000 || last > now;
}

/** ¿Sigue vivo el proceso? `kill(pid, 0)` no envía nada: solo pregunta (EPERM = vive, de otro usuario). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * ¿Hay una actualización en curso? Un candado caducado no cuenta, y tampoco uno cuyo
 * proceso ya no existe: tras apagar o reiniciar el PC a mitad de actualizar, el candado
 * se quedaba ahí y el vigilante no arrancaba Asistenta («actualizando») hasta 45 min.
 */
export function lockHeld(
  stateDir: string,
  now: number = Date.now(),
  alive: (pid: number) => boolean = pidAlive,
): boolean {
  const file = join(dir(stateDir), AUTOUPDATE_LOCK_FILE);
  try {
    if (now - statSync(file).mtimeMs >= LOCK_STALE_MS) return false;
  } catch {
    return false;
  }
  try {
    const pid = (JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown }).pid;
    if (
      typeof pid === 'number' &&
      Number.isInteger(pid) &&
      pid > 0 &&
      pid !== process.pid &&
      !alive(pid)
    )
      return false;
  } catch {
    // Recién creado y aún vacío, o ilegible: se respeta mientras no caduque.
  }
  return true;
}

/** Candado exclusivo (O_EXCL): dos revisiones nunca se pisan. Uno caducado se reemplaza. */
export function tryLock(
  stateDir: string,
  now: number = Date.now(),
  alive: (pid: number) => boolean = pidAlive,
): boolean {
  const file = join(dir(stateDir), AUTOUPDATE_LOCK_FILE);
  for (let i = 0; i < 2; i++) {
    try {
      mkdirSync(dir(stateDir), { recursive: true });
      closeSync(openSync(file, 'wx'));
      writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() }));
      return true;
    } catch {
      if (lockHeld(stateDir, now, alive)) return false;
      rmSync(file, { force: true });
    }
  }
  return false;
}

export function unlock(stateDir: string): void {
  rmSync(join(dir(stateDir), AUTOUPDATE_LOCK_FILE), { force: true });
}

/**
 * Renueva la fecha del candado antes de cada paso largo: en un PC lento `npm ci` y la
 * compilación (y deshacerlos) pueden pasar de 45 min, y un candado «viejo» dejaría al
 * vigilante arrancar Asistenta a media compilación o a otra revisión colarse.
 */
export function refreshLock(stateDir: string, now: number = Date.now()): void {
  try {
    const at = new Date(now);
    utimesSync(join(dir(stateDir), AUTOUPDATE_LOCK_FILE), at, at);
  } catch {
    // Sin candado que renovar (lo quitaron a mano): seguimos.
  }
}

/** «feat(tele): sube a tope (#712)» → «Sube a tope». */
export function cleanSubject(subject: string): string {
  let s = subject
    .trim()
    .replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, '')
    .replace(/\s*\(#\d+\)\s*$/, '')
    .trim();
  if (s.length > 110) s = `${s.slice(0, 109).trimEnd()}…`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function formatChangelog(subjects: string[], max: number = CHANGELOG_MAX): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const raw of subjects) {
    const s = cleanSubject(raw);
    if (!s || /^merge (pull request|branch|remote-tracking)/i.test(s)) continue;
    if (seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    items.push(s);
  }
  if (!items.length) return ['• Cambios internos'];
  const lines = items.slice(0, max).map((s) => `• ${s}`);
  const rest = items.length - max;
  if (rest > 0) lines.push(`y ${rest} ${rest === 1 ? 'cambio' : 'cambios'} más`);
  return lines;
}

export function successMessage(subjects: string[]): string {
  return ['🆕 Me he actualizado', ...formatChangelog(subjects)].join('\n');
}

export function failureMessage(reason: string): string {
  return `⚠️ No he podido actualizarme: ${reason}. Sigo con la versión anterior.\nDetalle: pa autoupdate status`;
}

export interface CmdResult {
  code: number;
  out: string;
}
export interface AutoupdateDeps {
  git(args: string[], timeoutMs?: number): Promise<CmdResult>;
  npm(args: string[], timeoutMs?: number): Promise<CmdResult>;
  daemonState(): DaemonRunState;
  busy(): BusyState;
  /** Cierre limpio del daemon, SIN marcarlo como parado a propósito. */
  stopDaemon(): Promise<void>;
  /** Arranca la tarea del daemon, igual que el vigilante. */
  startDaemon(): Promise<boolean>;
  backupDist(): void;
  restoreDist(): void;
  dropBackup(): void;
  notify(text: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Salida del paso que falló, para el registro de esta revisión. */
  log?(text: string): void;
}

const SKIPS: Record<string, string> = {
  apagado: 'autoactualización apagada',
  reciente: 'ya me actualicé hace menos de 30 min',
  'en-curso': 'otra actualización está en curso',
  'cambios-locales': 'hay cambios locales sin guardar en git: no toco nada',
  divergida:
    'tu copia tiene cambios propios que no están en la versión nueva: no toco nada para no perderlos',
  'no-en-marcha': 'Asistenta no está en marcha: espero a que vuelva',
  ocupada: 'Asistenta está haciendo algo o esperando tu permiso: lo dejo para luego',
  desconocido: 'no sé si Asistenta está ocupada: lo dejo para luego',
  'sin-git':
    'esta carpeta no viene de git (¿la bajaste en ZIP?) o git no está instalado: no puedo actualizarme sola. Para una versión nueva, baja el ZIP otra vez, o instala git y clona Asistenta (README, paso 2)',
};

/**
 * Arranca la tarea del daemon y espera a que vuelva sana. Justo tras un cierre la tarea
 * puede seguir «en ejecución» unos segundos y Windows ignora el arranque, así que mientras
 * siga parada se vuelve a pedir cada 20 s.
 */
async function startAndWait(deps: AutoupdateDeps, timeoutMs: number): Promise<boolean> {
  const deadline = deps.now() + timeoutMs;
  let nextKick = deps.now();
  while (deps.now() < deadline) {
    if (deps.daemonState() === 'running') {
      // Sigue viva un rato después: un arranque que se cae al momento no cuenta como sano.
      await deps.sleep(10_000);
      return deps.daemonState() === 'running';
    }
    if (deps.now() >= nextKick) {
      await deps.startDaemon();
      nextKick = deps.now() + 20_000;
    }
    await deps.sleep(2_000);
  }
  return false;
}

export const INTERRUPTED_MESSAGE =
  '⚠️ Una actualización se quedó a medias (¿se apagó o se suspendió el PC?). He vuelto a la versión anterior y lo reintentaré más tarde.';

/**
 * Deja Asistenta como estaba antes de una actualización cortada a mitad: vuelve al commit
 * anterior, reinstala dependencias si habían cambiado, recupera la compilación guardada y
 * arranca. Sin esto, la revisión siguiente veía HEAD ya en la versión nueva y decía «al
 * día» con la compilación o las dependencias a medio hacer.
 */
async function finishInterrupted(
  p: NonNullable<AutoupdateState['pending']>,
  deps: AutoupdateDeps,
  health: number,
  finish: (text: string) => Outcome,
): Promise<Outcome> {
  deps.log?.(`actualización a medias (${p.from.slice(0, 7)} → ${p.to.slice(0, 7)}): vuelvo atrás`);
  if (deps.daemonState() === 'running') await deps.stopDaemon().catch(() => {});
  const reset = await deps.git(['reset', '--keep', p.from]);
  const lockDiff = await deps.git(['diff', '--name-only', p.from, p.to, '--', 'package-lock.json']);
  if (lockDiff.code !== 0 || lockDiff.out.trim() !== '')
    await deps.npm(['ci', '--no-audit', '--no-fund'], 15 * 60_000);
  deps.restoreDist();
  const back = await startAndWait(deps, health);
  // Mismas palabras que la vuelta atrás de una actualización fallida: sin «git» ni «commit».
  const tail = [
    reset.code === 0
      ? ''
      : ' (y no he podido volver del todo a la versión anterior: prueba «pa doctor»)',
    back ? '' : ' (y no he vuelto a arrancar bien: prueba «pa doctor»)',
  ].join('');
  await deps.notify(`${INTERRUPTED_MESSAGE}${tail}`).catch(() => {});
  return finish(`se quedó a medias; he vuelto a la versión anterior${tail}`);
}

export async function runAutoupdate(
  stateDir: string,
  deps: AutoupdateDeps,
  opts: { force?: boolean; env?: NodeJS.ProcessEnv; healthTimeoutMs?: number } = {},
): Promise<Outcome> {
  const state = readAutoupdateState(stateDir);
  const prevCheck = state.lastCheckAt;
  // Toda revisión cuenta para el intervalo, salvo «aplazada»: esa se reintenta en la
  // siguiente pasada del vigilante (5 min), no dentro de 30.
  state.lastCheckAt = new Date(deps.now()).toISOString();
  const done = (kind: OutcomeKind, text: string): Outcome => {
    const fresh = readAutoupdateState(stateDir);
    writeAutoupdateState(stateDir, {
      ...fresh,
      lastCheckAt: kind === 'aplazada' ? prevCheck : state.lastCheckAt,
      lastUpdateAt: state.lastUpdateAt,
      failedRemote: state.failedRemote,
      failedAt: state.failedAt,
      pending: state.pending,
      last: { kind, text, at: new Date(deps.now()).toISOString() },
    });
    return { kind, text };
  };
  const skip = (reason: string, kind: OutcomeKind = 'omitida') =>
    done(kind, SKIPS[reason] ?? reason);

  if (state.pending) {
    if (!tryLock(stateDir, deps.now())) return { kind: 'omitida', text: SKIPS['en-curso'] ?? '' };
    try {
      return await finishInterrupted(
        state.pending,
        deps,
        opts.healthTimeoutMs ?? autoupdateHealthMs(opts.env),
        (t) => {
          state.pending = undefined;
          return done('revertida', t);
        },
      );
    } finally {
      unlock(stateDir);
    }
  }
  if (!autoupdateEnabled(stateDir, opts.env)) return skip('apagado');
  const lastUpdate = state.lastUpdateAt ? Date.parse(state.lastUpdateAt) : Number.NaN;
  if (!opts.force && deps.now() - lastUpdate < MIN_GAP_MS) return skip('reciente');
  if (!tryLock(stateDir, deps.now())) return { kind: 'omitida', text: SKIPS['en-curso'] ?? '' };
  const git: AutoupdateDeps['git'] = (args, t) => {
    refreshLock(stateDir, deps.now());
    return deps.git(args, t);
  };
  const npm: AutoupdateDeps['npm'] = (args, t) => {
    refreshLock(stateDir, deps.now());
    return deps.npm(args, t);
  };
  try {
    const head = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (head.code !== 0) return skip('sin-git');
    const branch = head.out.trim();
    if (branch !== 'main')
      return skip(`estás en la rama «${branch || '?'}»: solo me actualizo en main`);
    if ((await git(['fetch', '--quiet', 'origin', 'main'], 120_000)).code !== 0) {
      return skip('no pude mirar si hay versión nueva (¿sin internet?)', 'error');
    }
    const old = (await git(['rev-parse', 'HEAD'])).out.trim();
    const remote = (await git(['rev-parse', 'origin/main'])).out.trim();
    if (!old || !remote)
      return skip('no sé qué versión tengo instalada: prueba «pa doctor»', 'error');
    if (old === remote) return done('al-dia', `al día (${old.slice(0, 7)})`);
    const failedAt =
      state.failedRemote === remote && state.failedAt ? Date.parse(state.failedAt) : Number.NaN;
    if (!opts.force && deps.now() - failedAt < FAILED_RETRY_MS)
      return skip(
        `esta versión (${remote.slice(0, 7)}) ya falló al instalarse: lo reintento más tarde`,
      );
    const status = await git(['status', '--porcelain', '--untracked-files=no']);
    if (status.code !== 0 || status.out.trim()) return skip('cambios-locales');
    if ((await git(['merge-base', '--is-ancestor', old, remote])).code !== 0) {
      return skip('divergida');
    }
    if (deps.daemonState() !== 'running') return skip('no-en-marcha', 'aplazada');
    const busy = deps.busy();
    if (busy !== 'libre') return skip(busy, 'aplazada');

    const log = await git(['log', '--no-merges', '--format=%s', `${old}..${remote}`]);
    const subjects = log.out.split('\n').filter((l) => l.trim());
    const lockDiff = await git(['diff', '--name-only', old, remote, '--', 'package-lock.json']);
    const lockChanged = lockDiff.code !== 0 || lockDiff.out.trim() !== '';
    const health = opts.healthTimeoutMs ?? autoupdateHealthMs(opts.env);

    deps.backupDist();
    try {
      await deps.stopDaemon();
    } catch {
      deps.dropBackup();
      return skip('no pude parar Asistenta con un cierre limpio', 'error');
    }

    // Siempre con await: un `return rollback()` sin esperar soltaba el candado (finally) en
    // plena vuelta atrás y el vigilante podía arrancar Asistenta a medio `npm ci`.
    const rollback = async (reason: string, out = ''): Promise<Outcome> => {
      if (out) deps.log?.(`${reason}\n${out.slice(-4000)}`);
      const reset = await git(['reset', '--keep', old]);
      if (lockChanged) await npm(['ci', '--no-audit', '--no-fund'], 15 * 60_000);
      deps.restoreDist();
      if (deps.daemonState() === 'running') await deps.stopDaemon().catch(() => {});
      const back = await startAndWait(deps, health);
      const tail = [
        reset.code === 0
          ? ''
          : ' (y no he podido volver del todo a la versión anterior: prueba «pa doctor»)',
        back ? '' : ' (y no he vuelto a arrancar bien: prueba «pa doctor»)',
      ].join('');
      // Un solo aviso por versión: si la misma vuelve a fallar, solo queda en pa autoupdate status.
      if (state.failedRemote !== remote)
        await deps.notify(failureMessage(`${reason}${tail}`)).catch(() => {});
      state.failedRemote = remote;
      state.failedAt = new Date(deps.now()).toISOString();
      state.pending = undefined;
      return done('revertida', `falló (${reason}); sigue en ${old.slice(0, 7)}${tail}`);
    };

    state.pending = { from: old, to: remote, at: new Date(deps.now()).toISOString() };
    writeAutoupdateState(stateDir, { ...readAutoupdateState(stateDir), pending: state.pending });
    const merge = await git(['merge', '--ff-only', '--quiet', remote]);
    if (merge.code !== 0) return await rollback('no pude aplicar los cambios nuevos', merge.out);
    if (lockChanged) {
      const ci = await npm(['ci', '--no-audit', '--no-fund'], 15 * 60_000);
      if (ci.code !== 0)
        return await rollback('no pude instalar las piezas nuevas (¿sin internet?)', ci.out);
    }
    const build = await npm(['run', 'build'], 10 * 60_000);
    if (build.code !== 0) return await rollback('la versión nueva no se pudo preparar', build.out);
    if (!(await startAndWait(deps, health))) {
      if (deps.daemonState() === 'running') await deps.stopDaemon().catch(() => {});
      return await rollback(
        `la versión nueva no arrancaba bien (esperé ${Math.round(health / 1000)} s)`,
      );
    }
    deps.dropBackup();
    state.pending = undefined;
    state.lastUpdateAt = new Date(deps.now()).toISOString();
    state.failedRemote = undefined;
    state.failedAt = undefined;
    await deps.notify(successMessage(subjects)).catch(() => {});
    return done(
      'actualizada',
      `${old.slice(0, 7)} → ${remote.slice(0, 7)} (${subjects.length} cambios)`,
    );
  } finally {
    unlock(stateDir);
  }
}
