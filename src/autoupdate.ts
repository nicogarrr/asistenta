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
 * Si la copia tiene commits locales que ya están en origin/main por contenido (un arreglo
 * hecho en el PC que luego se fusionó como squash), los guarda en una rama copia-local-… y
 * hace `git reset --keep origin/main`. Los archivos sin seguimiento que la versión nueva
 * pisaría, y un package-lock.json tocado por `npm install`, se apartan a
 * <estado>/autoupdate/apartados/<fecha>/ (nunca se borran) y vuelven si hay marcha atrás.
 * Cada paso queda en <estado>/log/autoupdate.log.
 *
 * Nunca hace merge de verdad, nunca resetea encima de cambios locales de verdad y nunca toca
 * otra rama.
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
import { buildUpdateNotice, savePendingNovedades } from './autoupdate-novedades.js';
import { writeFileReplacing } from './fs-tmp.js';
import { BUSY_DIR, type BusyState } from './ocupada.js';
import { sliceSafe } from './text.js';

export { cleanSubject, formatChangelog, successMessage } from './autoupdate-novedades.js';

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
  /** PA_AUTOUPDATE_MODO=preguntar: cuándo se ofreció la última vez (una vez al día como mucho). */
  offeredAt?: string;
}

/** PA_AUTOUPDATE_MODO=preguntar: el vigilante no instala solo, pregunta con botones. */
export function autoupdateAsks(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(preguntar|ask)$/i.test(env.PA_AUTOUPDATE_MODO?.trim() ?? '');
}

/** En modo «preguntar», como mucho una oferta al día aunque main cambie más veces. */
export const OFFER_GAP_MS = 24 * 60 * 60_000;

export function offerText(changes: number, to: string): string {
  return `🔄 Hay una versión nueva de Asistenta (${to.slice(0, 7)}, ${changes} ${changes === 1 ? 'cambio' : 'cambios'}). ¿Me actualizo? Me cierro un par de minutos y te aviso aquí al volver; si algo falla, vuelvo a la de ahora.`;
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
  /** Qué tarea o permiso espera exactamente (para el aviso de «lo dejo para luego»). */
  busyWhy?(): string;
  /** Cierre limpio del daemon, SIN marcarlo como parado a propósito. */
  stopDaemon(): Promise<void>;
  /** Arranca la tarea del daemon, igual que el vigilante. */
  startDaemon(): Promise<boolean>;
  /** Lo último del log del lanzador de Windows (launcher.stderr.log), o null si no hay. */
  launcherLog?(): string | null;
  backupDist(): void;
  restoreDist(): void;
  dropBackup(): void;
  notify(text: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Salida del paso que falló, para el registro de esta revisión. */
  log?(text: string): void;
  /** Oferta con los botones «Actualizar» / «Luego» (modo preguntar). */
  offer?(text: string): Promise<void>;
  /** Una línea por paso al log de la autoactualización (log/autoupdate.log). */
  logStep?(line: string): void;
  /**
   * Aparta esos archivos (rutas relativas al repo) a una carpeta de copia, sin borrarlos.
   * Devuelve la carpeta y cómo devolverlos si hay que volver atrás.
   */
  moveAside?(paths: string[]): { dir: string; restore(): void };
}

/** Lo que la revisión decide hacer con la copia local antes de instalar. */
export type UpdatePlan =
  | {
      action: 'ff' | 'reset';
      /** Archivos sin seguimiento que la versión nueva pisaría: se apartan, no se borran. */
      aside: string[];
      /** package-lock.json tocado por un `npm install`: se aparta y se reinstala con npm ci. */
      discardLock: boolean;
      /** reset: cuántos commits locales ya estaban en origin/main (por contenido). */
      dupCommits: number;
    }
  | { action: 'refuse'; reason: 'cambios-locales' | 'divergida' };

/** Rutas de `git status --porcelain` (las dos formas «XY ruta» y «XY viejo -> nuevo»). */
export function porcelainPaths(out: string): string[] {
  return out
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l) =>
      l
        .slice(3)
        .split(' -> ')
        .map((x) => x.trim().replace(/^"(.*)"$/, '$1')),
    );
}

/**
 * ¿Los commits locales que no están en origin/main ya están ahí por contenido? Pasa cuando
 * un arreglo hecho en el PC se fusionó luego en GitHub como squash (otro SHA, mismo cambio):
 * `git cherry` los marca con «-» (mismo patch-id), o fusionar la copia local en origin/main
 * no cambia nada (mismo árbol), que cubre también los commits de merge de un `git pull`.
 */
export async function localAlreadyUpstream(
  git: AutoupdateDeps['git'],
  old: string,
  remote: string,
): Promise<{ ok: boolean; commits: number }> {
  const cherry = await git(['cherry', remote, old]);
  const lines = cherry.out.split('\n').filter((l) => /^[+-] /.test(l));
  if (cherry.code === 0 && lines.length > 0 && lines.every((l) => l.startsWith('- ')))
    return { ok: true, commits: lines.length };
  const merged = await git(['merge-tree', '--write-tree', remote, old]);
  const tree = (await git(['rev-parse', `${remote}^{tree}`])).out.trim();
  const ok = merged.code === 0 && tree !== '' && merged.out.split('\n')[0]?.trim() === tree;
  return { ok, commits: lines.length };
}

/**
 * La decisión, sin efectos: avanzar (fast-forward), volver a origin/main (los commits
 * locales ya están arriba) o no tocar nada (cambios de verdad). Los archivos sueltos que la
 * versión nueva traería se apartan a una copia; nunca se borran.
 */
export async function planUpdate(
  git: AutoupdateDeps['git'],
  old: string,
  remote: string,
): Promise<UpdatePlan> {
  const status = await git(['status', '--porcelain', '--untracked-files=no']);
  if (status.code !== 0) return { action: 'refuse', reason: 'cambios-locales' };
  const dirty = porcelainPaths(status.out);
  const discardLock = dirty.length > 0 && dirty.every((f) => f === 'package-lock.json');
  if (dirty.length > 0 && !discardLock) return { action: 'refuse', reason: 'cambios-locales' };
  let action: 'ff' | 'reset' = 'ff';
  let dupCommits = 0;
  if ((await git(['merge-base', '--is-ancestor', old, remote])).code !== 0) {
    const up = await localAlreadyUpstream(git, old, remote);
    if (!up.ok) return { action: 'refuse', reason: 'divergida' };
    action = 'reset';
    dupCommits = up.commits;
  }
  const others = await git(['ls-files', '-z', '--others', '--exclude-standard']);
  const loose = others.code === 0 ? others.out.split('\0').filter(Boolean) : [];
  let aside: string[] = [];
  if (loose.length) {
    const tree = await git(['ls-tree', '-r', '-z', '--name-only', remote]);
    // Sin distinguir mayúsculas: en Windows «Notas.md» y «notas.md» son el mismo archivo.
    const incoming = new Set(
      tree.out
        .split('\0')
        .filter(Boolean)
        .map((f) => f.toLowerCase()),
    );
    aside = loose.filter((f) => incoming.has(f.toLowerCase()));
  }
  return { action, aside, discardLock, dupCommits };
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

/** Lo que dejó escrito el lanzador de Windows (log/launcher.stderr.log) desde un momento. */
export interface LaunchSeen {
  /** El lanzador abrió `serve` («inicio de serve») después de ese momento. */
  started: boolean;
  /** Y `serve` ya terminó (se cerró) sin quedarse en marcha. */
  exited: boolean;
  /** Su última línea útil, en llano: sin rutas, tokens ni claves largas. */
  lastLine?: string;
}

/** Una línea del log apta para un aviso: sin fecha, rutas, tokens ni claves; corta. */
export function plainLogLine(line: string): string {
  let text = line
    .replace(/^\d{4}-\d\d-\d\dT\S+\s+/, '')
    .replace(/^error del launcher:\s*/, '')
    .replace(/\b(?:bot)?\d{6,}:[\w-]{20,}/g, '…')
    .replace(/[A-Za-z]:\\[^\s"'«»]*/g, '…')
    .replace(/(?:~|\/home|\/Users|\/tmp|\/var|\/root)\/[^\s"'«»]*/g, '…')
    .replace(/[\w+/=-]{32,}/g, '…')
    .replace(/[«»]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > 160) text = `${sliceSafe(text, 159)}…`;
  return text;
}

function stampMs(line: string): number {
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.\d+)?(Z|[+-]\d\d:\d\d)?\s/.exec(line);
  return m ? Date.parse(`${m[1]}${m[2] ?? ''}`) : Number.NaN;
}

/**
 * Lee el log del lanzador: si abrió `serve` desde `sinceMs`, si ya se cerró y su última
 * línea útil. Las líneas de `serve` no llevan fecha; las del lanzador sí.
 */
export function launchSince(text: string, sinceMs: number): LaunchSeen {
  const lines = text.split(/\r?\n/);
  let begin = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    if (/^\S+ inicio de serve/.test(line) && stampMs(line) >= sinceMs) {
      begin = i;
      break;
    }
  }
  if (begin < 0) return { started: false, exited: false };
  let exited = false;
  let lastLine: string | undefined;
  for (const line of lines.slice(begin + 1)) {
    if (/^\S+ serve termino: exit=/.test(line)) {
      exited = true;
      break;
    }
    if (/^\S+ error del launcher:/.test(line)) exited = true;
    if (!line.trim() || /^\s+at\s/.test(line) || /^\s*[{}]\s*$/.test(line)) continue;
    const plain = plainLogLine(line);
    if (plain) lastLine = plain;
  }
  return { started: true, exited, lastLine };
}

/**
 * Arranca la tarea del daemon y espera a que vuelva sana. Justo tras un cierre la tarea
 * puede seguir «en ejecución» unos segundos y Windows ignora el arranque, así que mientras
 * siga parada se vuelve a pedir cada 20 s. Si el lanzador dice que `serve` ya se cerró, no
 * espera más; si falla, `why` dice por qué en llano.
 */
async function startAndWait(
  deps: AutoupdateDeps,
  timeoutMs: number,
): Promise<{ ok: boolean; why: string }> {
  const since = deps.now() - 5_000;
  const deadline = deps.now() + timeoutMs;
  const secs = Math.round(timeoutMs / 1000);
  const seen = (): LaunchSeen | null => {
    const text = deps.launcherLog?.();
    return typeof text === 'string' ? launchSince(text, since) : null;
  };
  let nextKick = deps.now();
  while (deps.now() < deadline) {
    if (deps.daemonState() === 'running') {
      // Sigue viva un rato después: un arranque que se cae al momento no cuenta como sano.
      await deps.sleep(10_000);
      if (deps.daemonState() === 'running') return { ok: true, why: '' };
      break;
    }
    if (seen()?.exited) break;
    if (deps.now() >= nextKick) {
      await deps.startDaemon();
      nextKick = deps.now() + 20_000;
    }
    await deps.sleep(2_000);
  }
  const last = seen();
  const quote = last?.lastLine ? ` («${last.lastLine}»)` : '';
  if (last?.exited) return { ok: false, why: `la versión nueva se cerró al arrancar${quote}` };
  if (last?.started)
    return { ok: false, why: `la versión nueva seguía arrancando a los ${secs} s${quote}` };
  if (last) return { ok: false, why: `Windows no llegó a abrir la versión nueva en ${secs} s` };
  return { ok: false, why: `la versión nueva no arrancaba bien (esperé ${secs} s)` };
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
  const back = (await startAndWait(deps, health)).ok;
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

/** Un archivo que Windows aún tiene abierto (otro proceso, el antivirus, un handle que tarda). */
const LOCKED_FILE = /\b(EPERM|EBUSY|ENOTEMPTY|EACCES)\b/;

/**
 * `npm ci` con dos reintentos si falla por un archivo bloqueado: en Windows un proceso que
 * acaba de cerrarse (Asistenta, un worker de voz) o el antivirus sueltan los .node con unos
 * segundos de retraso, y el primer `npm ci` choca con ellos (EPERM/EBUSY).
 */
export async function npmCiRetrying(
  npm: AutoupdateDeps['npm'],
  sleep: AutoupdateDeps['sleep'],
  step: (line: string) => void = () => {},
): Promise<CmdResult> {
  const waits = [5_000, 15_000];
  for (let i = 0; ; i++) {
    const ci = await npm(['ci', '--no-audit', '--no-fund'], 15 * 60_000);
    step(`npm ci → ${ci.code}${i ? ` (reintento ${i})` : ''}`);
    const wait = waits[i];
    if (ci.code === 0 || wait === undefined || !LOCKED_FILE.test(ci.out)) return ci;
    await sleep(wait);
  }
}

/** Por qué no se pudo instalar, en llano: archivo bloqueado o red. */
export function npmCiFailReason(out: string): string {
  return LOCKED_FILE.test(out)
    ? 'algún archivo de Asistenta seguía abierto en Windows (¿otra Asistenta o una ventana de node abierta?)'
    : 'no pude instalar las piezas nuevas (¿sin internet?)';
}

export async function runAutoupdate(
  stateDir: string,
  deps: AutoupdateDeps,
  opts: {
    force?: boolean;
    env?: NodeJS.ProcessEnv;
    healthTimeoutMs?: number;
    /** Justo antes de parar Asistenta para instalar una versión nueva (el botón lo avisa). */
    onUpdating?: (info: { from: string; to: string; changes: number }) => Promise<void>;
  } = {},
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
  const step = (line: string) => {
    try {
      deps.logStep?.(line);
    } catch {
      // Solo diagnóstico.
    }
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
    step(`revisión: tengo ${old.slice(0, 7)}, origin/main ${remote.slice(0, 7)}`);
    if (old === remote) return done('al-dia', `al día (${old.slice(0, 7)})`);
    const failedAt =
      state.failedRemote === remote && state.failedAt ? Date.parse(state.failedAt) : Number.NaN;
    if (!opts.force && deps.now() - failedAt < FAILED_RETRY_MS)
      return skip(
        `esta versión (${remote.slice(0, 7)}) ya falló al instalarse: lo reintento más tarde`,
      );
    const plan = await planUpdate(git, old, remote);
    step(
      plan.action === 'refuse'
        ? `no se actualiza: ${plan.reason}`
        : `plan: ${plan.action}${plan.dupCommits ? ` (${plan.dupCommits} commits locales ya en origin/main)` : ''}, apartar ${plan.aside.length}${plan.discardLock ? ' + package-lock.json' : ''}`,
    );
    if (plan.action === 'refuse') return skip(plan.reason);
    const toMove = [...plan.aside, ...(plan.discardLock ? ['package-lock.json'] : [])];
    if (toMove.length && !deps.moveAside) return skip('cambios-locales');
    if (!opts.force && autoupdateAsks(opts.env)) {
      // Nunca instala sin un toque del dueño: ofrece (una vez al día) y espera al botón.
      const offered = state.offeredAt ? Date.parse(state.offeredAt) : Number.NaN;
      if (deps.now() - offered < OFFER_GAP_MS || !deps.offer)
        return done(
          'omitida',
          `hay versión nueva (${remote.slice(0, 7)}): esperando tu toque en Telegram`,
        );
      const log = await git(['log', '--no-merges', '--format=%s', `${old}..${remote}`]);
      const n = log.out.split('\n').filter((l) => l.trim()).length;
      await deps.offer(offerText(n, remote)).catch(() => {});
      const fresh = readAutoupdateState(stateDir);
      writeAutoupdateState(stateDir, { ...fresh, offeredAt: new Date(deps.now()).toISOString() });
      step(`ofrecida ${remote.slice(0, 7)} (modo preguntar)`);
      return done('omitida', `te he preguntado si me actualizo a ${remote.slice(0, 7)}`);
    }
    if (deps.daemonState() !== 'running') return skip('no-en-marcha', 'aplazada');
    const busy = deps.busy();
    if (busy === 'ocupada') {
      const why = deps.busyWhy?.() ?? '';
      return skip(why ? `${SKIPS.ocupada ?? ''}. Espera: ${why}` : busy, 'aplazada');
    }
    if (busy !== 'libre') return skip(busy, 'aplazada');

    const log = await git(['log', '--no-merges', '--format=%s', `${old}..${remote}`]);
    const subjects = log.out.split('\n').filter((l) => l.trim());
    const lockDiff = await git(['diff', '--name-only', old, remote, '--', 'package-lock.json']);
    const lockChanged = plan.discardLock || lockDiff.code !== 0 || lockDiff.out.trim() !== '';
    const health = opts.healthTimeoutMs ?? autoupdateHealthMs(opts.env);

    await opts.onUpdating?.({ from: old, to: remote, changes: subjects.length }).catch(() => {});
    deps.backupDist();
    try {
      await deps.stopDaemon();
    } catch {
      deps.dropBackup();
      return skip('no pude parar Asistenta con un cierre limpio', 'error');
    }

    // Siempre con await: un `return rollback()` sin esperar soltaba el candado (finally) en
    // plena vuelta atrás y el vigilante podía arrancar Asistenta a medio `npm ci`.
    let moved: { dir: string; restore(): void } | undefined;
    const rollback = async (reason: string, out = ''): Promise<Outcome> => {
      step(`fallo: ${reason}; vuelvo a ${old.slice(0, 7)}`);
      if (out) deps.log?.(`${reason}\n${out.slice(-4000)}`);
      const reset = await git(['reset', '--keep', old]);
      if (lockChanged) await npmCiRetrying(npm, deps.sleep, step);
      try {
        moved?.restore();
      } catch (err) {
        step(`no pude devolver los archivos apartados (siguen en ${moved?.dir}): ${String(err)}`);
      }
      deps.restoreDist();
      if (deps.daemonState() === 'running') await deps.stopDaemon().catch(() => {});
      const back = (await startAndWait(deps, health)).ok;
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
    if (toMove.length && deps.moveAside) {
      try {
        moved = deps.moveAside(toMove);
        step(`apartados ${toMove.length} archivos a ${moved.dir}`);
      } catch (err) {
        return await rollback('no pude apartar los archivos sueltos', String(err));
      }
      if (plan.discardLock) await git(['checkout', '--', 'package-lock.json']);
    }
    let keptAs = '';
    if (plan.action === 'reset') {
      // Los commits locales ya están arriba, pero quedan en una rama por si acaso.
      keptAs = `copia-local-${new Date(deps.now()).toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
      await git(['branch', '-f', keptAs, old]);
      step(`commits locales guardados en la rama ${keptAs}`);
    }
    const merge =
      plan.action === 'reset'
        ? await git(['reset', '--keep', remote])
        : await git(['merge', '--ff-only', '--quiet', remote]);
    step(`${plan.action === 'reset' ? 'git reset --keep' : 'git merge --ff-only'} → ${merge.code}`);
    if (merge.code !== 0) return await rollback('no pude aplicar los cambios nuevos', merge.out);
    if (lockChanged) {
      const ci = await npmCiRetrying(npm, deps.sleep, step);
      if (ci.code !== 0) return await rollback(npmCiFailReason(ci.out), ci.out);
    }
    const build = await npm(['run', 'build'], 10 * 60_000);
    step(`npm run build → ${build.code}`);
    if (build.code !== 0) return await rollback('la versión nueva no se pudo preparar', build.out);
    const health1 = await startAndWait(deps, health);
    step(health1.ok ? 'arrancada y sana' : `no arrancó bien: ${health1.why}`);
    if (!health1.ok) {
      if (deps.daemonState() === 'running') await deps.stopDaemon().catch(() => {});
      return await rollback(health1.why);
    }
    deps.dropBackup();
    state.pending = undefined;
    state.lastUpdateAt = new Date(deps.now()).toISOString();
    state.failedRemote = undefined;
    state.failedAt = undefined;
    // Lo que no cabe en el aviso queda apuntado: un «sí» del dueño lo trae (daemon).
    const notice = buildUpdateNotice(subjects);
    notice.text = `${notice.text}\nVersión nueva: ${remote.slice(0, 7)}`;
    savePendingNovedades(stateDir, notice.rest, deps.now());
    const extra = [
      keptAs
        ? `Tus commits locales ya estaban en la versión nueva; por si acaso quedan en la rama ${keptAs}.`
        : '',
      moved
        ? `Aparté ${toMove.length} archivo(s) sueltos que la versión nueva pisaba: ${moved.dir}`
        : '',
    ].filter(Boolean);
    await deps.notify([notice.text, ...extra].join('\n')).catch(() => {});
    return done(
      'actualizada',
      `${old.slice(0, 7)} → ${remote.slice(0, 7)} (${subjects.length} ${subjects.length === 1 ? 'cambio' : 'cambios'})`,
    );
  } finally {
    unlock(stateDir);
  }
}
