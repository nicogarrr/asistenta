/**
 * Ojo de águila, parte 4: descargas nuevas.
 *
 * Nace APAGADO y solo se enciende con `/ojo descargas on`. Vigila la carpeta de
 * Descargas (autodetectada: %USERPROFILE%\Downloads en Windows, ~/Downloads en el resto;
 * `ojo:downloadsDir` en la bóveda la sustituye) con el `FileWatcher` ya existente, que
 * espera a que el archivo termine de escribirse. Solo mira archivos sueltos de esa
 * carpeta (no subcarpetas: extraer un zip no son cincuenta avisos) y NUNCA lee su
 * contenido: se dice el nombre, el tipo por extensión y el tamaño.
 *
 * Las descargas se guardan como pendientes en sqlite y salen en el barrido del vigilante
 * (DM del owner verificado, horas de silencio, un solo digest). Al apagar se descarta lo
 * pendiente: nada viejo aparece después.
 */

import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { log } from './log.js';
import { sliceSafe } from './text.js';
import { type FileEvent, FileWatcher } from './watch/files.js';

const SETTING_KEY = 'downloads_enabled';
export const MAX_PENDING = 50;
export const MAX_LISTED = 5;
/** Una descarga que no se pudo avisar en este tiempo ya no es una novedad. */
export const STALE_MS = 12 * 3_600_000;
const NAME_MAX = 60;

export function initDownloadsStore(db: DatabaseSync): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS vigilante_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  );
  db.exec(`
    CREATE TABLE IF NOT EXISTS vigilante_downloads (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      ext TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      at INTEGER NOT NULL,
      status TEXT NOT NULL
    )
  `);
}

/** Apagado por defecto: solo `on` explícito lo enciende. */
export function getDownloadsEnabled(db: DatabaseSync): boolean {
  initDownloadsStore(db);
  const row = db.prepare('SELECT value FROM vigilante_settings WHERE key = ?').get(SETTING_KEY) as
    | { value: string }
    | undefined;
  return row?.value === 'on';
}

export function setDownloadsEnabled(db: DatabaseSync, enabled: boolean): void {
  initDownloadsStore(db);
  const wasOn = getDownloadsEnabled(db);
  db.prepare(
    'INSERT INTO vigilante_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(SETTING_KEY, enabled ? 'on' : 'off');
  // Los contadores de pérdidas solo se reinician en la transición real apagado -> encendido;
  // repetir "on" no borra avisos de saturación pendientes.
  if (enabled && !wasOn) {
    putNum(db, CAP_DROPPED_KEY, 0);
    putNum(db, LOST_REPORTED_KEY, 0);
  }
  // Al apagar, lo pendiente se descarta: no debe aparecer después, fuera de contexto.
  if (!enabled)
    db.prepare(
      "UPDATE vigilante_downloads SET status = 'descartada' WHERE status = 'pendiente'",
    ).run();
}

/**
 * Carpeta de Descargas. Primero la config explícita; después la del sistema (Windows:
 * %USERPROFILE%\Downloads; resto: ~/Downloads). Devuelve null si no existe como carpeta.
 */
export function resolveDownloadsDir(opts: {
  override?: string | undefined;
  platform?: string;
  env?: Record<string, string | undefined>;
  home?: string;
  isDir?: (p: string) => boolean;
}): string | null {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const isDir = opts.isDir ?? ((p: string) => existsSync(p) && statSync(p).isDirectory());
  const override = opts.override?.trim();
  if (override) return isDir(override) ? resolve(override) : null;
  const base = platform === 'win32' ? env.USERPROFILE?.trim() || home : home;
  const dir = platform === 'win32' ? `${base}\\Downloads` : join(base, 'Downloads');
  return isDir(dir) ? dir : null;
}

const KINDS: Array<[RegExp, string]> = [
  [/^\.(pdf)$/, 'PDF'],
  [/^\.(png|jpe?g|gif|webp|heic|bmp|svg)$/, 'imagen'],
  [/^\.(docx?|odt|rtf|txt|md)$/, 'documento'],
  [/^\.(xlsx?|ods|csv)$/, 'hoja de cálculo'],
  [/^\.(pptx?|odp|key)$/, 'presentación'],
  [/^\.(zip|rar|7z|tar|gz|tgz)$/, 'archivo comprimido'],
  [/^\.(exe|msi|msix|dmg|pkg|deb|appimage|bat|cmd|ps1|sh|jar)$/, 'instalador o programa'],
  [/^\.(mp4|mkv|mov|avi|webm)$/, 'vídeo'],
  [/^\.(mp3|wav|m4a|flac|ogg)$/, 'audio'],
];

export function fileKind(ext: string): string {
  const e = ext.toLowerCase();
  for (const [re, label] of KINDS) if (re.test(e)) return label;
  return 'archivo';
}

/** Nombre apto para un mensaje: sin saltos de línea ni caracteres de control, acotado. */
export function safeName(name: string): string {
  // Fuera TODA la categoría Unicode "Other": control (C0, DEL, C1), formato (bidi, aislantes, ALM, ZW*, BOM), sin asignar y de uso privado.
  const clean = name
    .replace(/[\p{C}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > NAME_MAX ? `${sliceSafe(clean, NAME_MAX - 1)}…` : clean || '(sin nombre)';
}

const NOISE_NAMES = new Set(['desktop.ini', 'thumbs.db', '.ds_store']);

/** Solo archivos sueltos en la carpeta vigilada; fuera ruido del sistema y dotfiles. */
export function wantedPath(dir: string, path: string): boolean {
  if (dirname(resolve(path)) !== resolve(dir)) return false;
  const name = basename(path).toLowerCase();
  return !NOISE_NAMES.has(name) && !name.startsWith('.');
}

export function recordDownload(db: DatabaseSync, dir: string, ev: FileEvent, now: number): boolean {
  if (ev.kind !== 'created' || ev.bytes === undefined || ev.bytes <= 0) return false;
  if (!getDownloadsEnabled(db) || !wantedPath(dir, ev.path)) return false;
  const name = basename(ev.path);
  const key = `${resolve(ev.path)}|${ev.bytes}`;
  const res = db
    .prepare(
      "INSERT OR IGNORE INTO vigilante_downloads (key, name, ext, bytes, at, status) VALUES (?, ?, ?, ?, ?, 'pendiente')",
    )
    .run(key, name, extname(name).toLowerCase(), ev.bytes, now);
  if (Number(res.changes) === 0) return false;
  // Tope: lo más antiguo pendiente se descarta si se acumula demasiado (y se cuenta).
  const dropped = db
    .prepare(
      "UPDATE vigilante_downloads SET status = 'descartada' WHERE status = 'pendiente' AND key NOT IN (SELECT key FROM vigilante_downloads WHERE status = 'pendiente' ORDER BY at DESC, rowid DESC LIMIT ?)",
    )
    .run(MAX_PENDING);
  if (Number(dropped.changes) > 0) addSetting(db, CAP_DROPPED_KEY, Number(dropped.changes));
  return true;
}

const CAP_DROPPED_KEY = 'downloads_cap_dropped';
const LOST_REPORTED_KEY = 'downloads_lost_reported';

function getNum(db: DatabaseSync, key: string): number {
  const row = db.prepare('SELECT value FROM vigilante_settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  const n = Number(row?.value);
  return Number.isFinite(n) ? n : 0;
}
function putNum(db: DatabaseSync, key: string, n: number): void {
  db.prepare(
    'INSERT INTO vigilante_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, String(n));
}
function addSetting(db: DatabaseSync, key: string, n: number): void {
  putNum(db, key, getNum(db, key) + n);
}

/**
 * Descargas que NO se pudieron avisar por saturación: las que el vigilante de carpeta
 * suprimió por ritmo (`suppressed`, pasado por quien lo tiene) y las que el tope de 50
 * pendientes descartó. Devuelve cuántas son nuevas desde el último aviso.
 */
export function lostSinceReport(
  db: DatabaseSync,
  suppressed: number,
): { lost: number; total: number } {
  initDownloadsStore(db);
  const total = getNum(db, CAP_DROPPED_KEY) + Math.max(0, suppressed);
  const reported = getNum(db, LOST_REPORTED_KEY);
  if (total < reported) putNum(db, LOST_REPORTED_KEY, total); // el vigilante se reinició
  return { lost: Math.max(0, total - reported), total };
}

export function markLostReported(db: DatabaseSync, total: number): void {
  putNum(db, LOST_REPORTED_KEY, total);
}

export interface PendingDownload {
  key: string;
  name: string;
  ext: string;
  bytes: number;
  at: number;
}

/** Pendientes recientes (las viejas pasan a descartadas). Solo si el interruptor está encendido. */
export function pendingDownloads(db: DatabaseSync, now: number): PendingDownload[] {
  initDownloadsStore(db);
  if (!getDownloadsEnabled(db)) return [];
  db.prepare(
    "UPDATE vigilante_downloads SET status = 'descartada' WHERE status = 'pendiente' AND at < ?",
  ).run(now - STALE_MS);
  return db
    .prepare(
      "SELECT key, name, ext, bytes, at FROM vigilante_downloads WHERE status = 'pendiente' ORDER BY at, rowid",
    )
    .all() as unknown as PendingDownload[];
}

export function markDownloadsNotified(db: DatabaseSync, keys: readonly string[]): void {
  if (keys.length === 0) return;
  const upd = db.prepare(
    "UPDATE vigilante_downloads SET status = 'avisada' WHERE key = ? AND status = 'pendiente'",
  );
  for (const k of keys) upd.run(k);
}

const size = (b: number): string =>
  b >= 1_048_576
    ? `${(b / 1_048_576).toFixed(1).replace('.', ',')} MB`
    : `${Math.max(1, Math.round(b / 1024))} KB`;

export function formatDownloads(items: readonly PendingDownload[], lost = 0): string {
  const shown = items.slice(0, MAX_LISTED);
  const lines = shown.map((d) => `• ${safeName(d.name)} (${fileKind(d.ext)}, ${size(d.bytes)})`);
  const more = items.length - shown.length;
  if (more > 0) lines.push(`• y ${more} más`);
  if (lost > 0) lines.push(`• y ${lost} más que no pude seguir (llegaron demasiado rápido)`);
  const head =
    items.length === 0
      ? `📥 Descargas: llegaron demasiadas a la vez y ${lost} no las pude seguir`
      : `📥 Descargas nuevas: ${items.length === 1 ? '1 archivo' : `${items.length} archivos`} (solo el nombre, no he abierto nada)`;
  return items.length === 0 ? head : `${head}\n${lines.join('\n')}`;
}

export interface DownloadsState {
  running: boolean;
  dir: string | null;
  reason?: string;
}

/**
 * Ciclo de vida del vigilante de carpeta: un FileWatcher por encendido (empieza y para una
 * vez). `running` es el estado REAL (hay un handle vivo), no el deseo: cada `apply` hace
 * health check y reintenta una vez si el vigilante murió. `stop()` es definitivo (apagado del
 * daemon): invalida cualquier arranque en vuelo y nada vuelve a empezar después.
 */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error('timeout')), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

export function createDownloadsController(opts: {
  db: DatabaseSync;
  getOverride: () => Promise<string | undefined>;
  overrideTimeoutMs?: number;
  now?: () => number;
  /** Extra sink for each recorded download (event triggers). Never blocks recording. */
  onNew?: (filename: string) => void;
}): {
  apply: () => Promise<DownloadsState>;
  stop: () => void;
  suppressed: () => number;
} {
  let watcher: FileWatcher | null = null;
  let watchedDir: string | null = null;
  let closed = false;
  let gen = 0;
  let suppressedBase = 0;

  const dropWatcher = (): void => {
    if (watcher) suppressedBase += watcher.suppressed();
    watcher?.stop();
    watcher = null;
    watchedDir = null;
  };
  const stop = (): void => {
    closed = true;
    gen++;
    dropWatcher();
  };

  const startWatcher = (dir: string): DownloadsState => {
    try {
      const w = new FileWatcher({
        dirs: [dir],
        ignore: (p) => !wantedPath(dir, p),
        onEvent: (ev) => {
          if (closed) return;
          let recorded = false;
          try {
            recorded = recordDownload(opts.db, dir, ev, (opts.now ?? Date.now)());
          } catch (err) {
            log.warn('descargas: no se pudo guardar', { err: String(err) });
          }
          // Only a genuinely NEW download fires: a duplicate event must not
          // re-trigger routines for a file the user already saw.
          if (!recorded) return;
          try {
            opts.onNew?.(ev.path);
          } catch (err) {
            log.warn('descargas: onNew falló', { err: String(err) });
          }
        },
      });
      w.start();
      if (w.active() === 0) {
        w.stop();
        return { running: false, dir, reason: 'no he podido vigilar la carpeta' };
      }
      watcher = w;
      watchedDir = dir;
      return { running: true, dir };
    } catch (err) {
      log.warn('descargas: no se pudo vigilar la carpeta', { err: String(err) });
      return { running: false, dir, reason: 'no he podido vigilar la carpeta' };
    }
  };

  const applyOnce = async (): Promise<DownloadsState> => {
    if (closed) return { running: false, dir: null, reason: 'apagado' };
    if (!getDownloadsEnabled(opts.db)) {
      dropWatcher();
      suppressedBase = 0; // sesión nueva en el próximo encendido, igual que los contadores SQLite
      return { running: false, dir: null };
    }
    // Health check: un vigilante sin handles vivos está muerto; se retira y se reintenta.
    if (watcher && watcher.active() === 0) {
      log.warn('descargas: el vigilante de carpeta murió; reintentando', {});
      dropWatcher();
    }
    if (watcher) return { running: true, dir: watchedDir };
    const myGen = gen;
    let override: Awaited<ReturnType<typeof opts.getOverride>>;
    try {
      override = await withDeadline(opts.getOverride(), opts.overrideTimeoutMs ?? 10_000);
    } catch {
      return { running: false, dir: null, reason: 'la bóveda no respondió a tiempo' };
    }
    // Tras la espera: ni apagado del daemon, ni /ojo descargas off, ni otra generación.
    if (closed || myGen !== gen || !getDownloadsEnabled(opts.db)) {
      return {
        running: false,
        dir: null,
        reason: closed ? 'apagado' : undefined,
      } as DownloadsState;
    }
    const dir = resolveDownloadsDir({ override });
    if (!dir) return { running: false, dir: null, reason: 'no encuentro la carpeta de Descargas' };
    return startWatcher(dir);
  };

  let chain: Promise<unknown> = Promise.resolve();
  const apply = (): Promise<DownloadsState> => {
    // Serializado: dos "on" seguidos no crean dos vigilantes.
    const next = chain.then(applyOnce, applyOnce);
    chain = next;
    return next;
  };

  return {
    apply,
    stop,
    suppressed: () => suppressedBase + (watcher?.suppressed() ?? 0),
  };
}
