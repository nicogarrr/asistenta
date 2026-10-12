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
  db.prepare(
    'INSERT INTO vigilante_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(SETTING_KEY, enabled ? 'on' : 'off');
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
  // biome-ignore lint/suspicious/noControlCharactersInRegex: se eliminan a propósito
  const clean = name
    .replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > NAME_MAX ? `${clean.slice(0, NAME_MAX - 1)}…` : clean || '(sin nombre)';
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
  // Tope: lo más antiguo pendiente se descarta si se acumula demasiado.
  db.prepare(
    "UPDATE vigilante_downloads SET status = 'descartada' WHERE status = 'pendiente' AND key NOT IN (SELECT key FROM vigilante_downloads WHERE status = 'pendiente' ORDER BY at DESC, rowid DESC LIMIT ?)",
  ).run(MAX_PENDING);
  return true;
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

export function formatDownloads(items: readonly PendingDownload[]): string {
  const shown = items.slice(0, MAX_LISTED);
  const lines = shown.map((d) => `• ${safeName(d.name)} (${fileKind(d.ext)}, ${size(d.bytes)})`);
  const more = items.length - shown.length;
  if (more > 0) lines.push(`• y ${more} más`);
  return `📥 Descargas nuevas: ${items.length === 1 ? '1 archivo' : `${items.length} archivos`} (solo el nombre, no he abierto nada)\n${lines.join('\n')}`;
}

/** Ciclo de vida del vigilante de carpeta: un FileWatcher por encendido (empieza y para una vez). */
export function createDownloadsController(opts: {
  db: DatabaseSync;
  getOverride: () => Promise<string | undefined>;
  now?: () => number;
}): {
  apply: () => Promise<{ running: boolean; dir: string | null; reason?: string }>;
  stop: () => void;
} {
  let watcher: FileWatcher | null = null;
  let watchedDir: string | null = null;
  const stop = (): void => {
    watcher?.stop();
    watcher = null;
    watchedDir = null;
  };
  let chain: Promise<unknown> = Promise.resolve();
  const apply = (): ReturnType<typeof applyOnce> => {
    // Serializado: dos "on" seguidos no crean dos vigilantes.
    const next = chain.then(applyOnce, applyOnce);
    chain = next;
    return next;
  };
  const applyOnce = async (): Promise<{
    running: boolean;
    dir: string | null;
    reason?: string;
  }> => {
    if (!getDownloadsEnabled(opts.db)) {
      stop();
      return { running: false, dir: null };
    }
    if (watcher) return { running: true, dir: watchedDir };
    const dir = resolveDownloadsDir({ override: await opts.getOverride() });
    if (!dir) return { running: false, dir: null, reason: 'no encuentro la carpeta de Descargas' };
    try {
      const w = new FileWatcher({
        dirs: [dir],
        ignore: (p) => !wantedPath(dir, p),
        onEvent: (ev) => {
          try {
            recordDownload(opts.db, dir, ev, (opts.now ?? Date.now)());
          } catch (err) {
            log.warn('descargas: no se pudo guardar', { err: String(err) });
          }
        },
      });
      w.start();
      watcher = w;
      watchedDir = dir;
      return { running: true, dir };
    } catch (err) {
      log.warn('descargas: no se pudo vigilar la carpeta', { err: String(err) });
      return { running: false, dir, reason: 'no he podido vigilar la carpeta' };
    }
  };
  return { apply, stop };
}
