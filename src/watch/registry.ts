/**
 * Registro único de vigilancias.
 *
 * Hasta ahora cada tipo de vigilancia (páginas, precios, bandeja, calendario,
 * ficheros) sabía dónde vivía su propia lista. Eso hacía imposible responder a la
 * pregunta que importa para ser proactivo: "¿qué está vigilando el agente y cuándo
 * toca volver a mirarlo?". Este módulo no ejecuta ninguna vigilancia; solo guarda
 * la intención, su chat de destino y la cadencia, en un único JSON bajo el state dir.
 *
 * Decisiones:
 * - El fichero es la fuente de verdad y se lee en cada operación. La lista es
 *   pequeña (tope 200) y así dos procesos no se pisan una caché en memoria.
 * - La escritura es atómica (temporal + rename). Un corte a mitad nunca deja un
 *   JSON truncado que perdería todas las vigilancias a la vez.
 * - `schedule` es una cadencia simple basada en `lastRunMs`, no un cron: el
 *   planificador pregunta `dueForPush(now)` y decide. Sin schedule es manual.
 * - Un registro corrupto se aparta (`.corrupt-<ms>`) en vez de sobrescribirse: el
 *   usuario puede recuperarlo, y el agente arranca con una lista vacía.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { log } from '../log.js';
import { paths } from '../paths.js';

export type WatchKind = 'page' | 'price' | 'inbox' | 'calendar' | 'file';
export type WatchSchedule = '15m' | '1h' | '6h' | 'daily';

export interface Watch {
  id: string;
  kind: WatchKind;
  /** URL, carpeta, cuenta o lo que identifique el objetivo de la vigilancia. */
  target: string;
  note?: string;
  /** Chat al que se empuja el aviso. */
  chatId: string;
  threadId?: string;
  /** Sin schedule = solo bajo demanda. */
  schedule?: WatchSchedule;
  enabled: boolean;
  createdAt: number;
  /** Última ejecución real; ausente = nunca se ha ejecutado. */
  lastRunMs?: number;
}

export interface AddWatchInput {
  kind: WatchKind;
  target: string;
  chatId: string;
  note?: string;
  threadId?: string;
  /** `null` equivale a omitirlo: vigilancia manual. */
  schedule?: WatchSchedule | null;
  enabled?: boolean;
  /** Solo para importar/migrar; si no se da se genera uno único. */
  id?: string;
  createdAt?: number;
}

export interface WatchFilter {
  chatId?: string;
  threadId?: string;
  kind?: WatchKind;
  enabled?: boolean;
}

export interface WatchRegistryOptions {
  file?: string;
  now?: () => number;
  max?: number;
}

/** Tope duro: una lista sin límite acaba siendo una lista que nadie revisa. */
export const MAX_WATCHES = 200;

export const SCHEDULE_MS: Readonly<Record<WatchSchedule, number>> = {
  '15m': 15 * 60_000,
  '1h': 3_600_000,
  '6h': 6 * 3_600_000,
  daily: 24 * 3_600_000,
};

const KINDS: ReadonlySet<string> = new Set(['page', 'price', 'inbox', 'calendar', 'file']);
const SCHEDULES: ReadonlySet<string> = new Set(['15m', '1h', '6h', 'daily']);

const MAX_TARGET = 2_048;
const MAX_NOTE = 500;
const MAX_ID = 200;

/** `paths.state/watch/registry.json`, el único sitio donde vive la lista. */
export function registryFile(): string {
  return join(paths.state, 'watch', 'registry.json');
}

function isWatchKind(value: unknown): value is WatchKind {
  return typeof value === 'string' && KINDS.has(value);
}

function isSchedule(value: unknown): value is WatchSchedule {
  return typeof value === 'string' && SCHEDULES.has(value);
}

function cleanId(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, MAX_ID);
}

/** Objetivo: se conserva tal cual (una ruta puede tener espacios), sin saltos de línea. */
function cleanTarget(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, MAX_TARGET);
}

function cleanNote(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE);
  return text || undefined;
}

function cleanChat(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, MAX_ID);
}

function finiteMs(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function fromStored(raw: unknown): Watch | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const id = cleanId(row.id);
  const target = cleanTarget(row.target);
  const chatId = cleanChat(row.chatId);
  if (!id || !target || !chatId || !isWatchKind(row.kind)) return null;

  const note = cleanNote(row.note);
  const threadId = cleanChat(row.threadId);
  const createdAt = finiteMs(row.createdAt) ?? 0;
  const lastRunMs = finiteMs(row.lastRunMs);
  const schedule = isSchedule(row.schedule) ? row.schedule : undefined;
  return {
    id,
    kind: row.kind,
    target,
    ...(note ? { note } : {}),
    chatId,
    ...(threadId ? { threadId } : {}),
    ...(schedule ? { schedule } : {}),
    enabled: row.enabled !== false,
    createdAt,
    ...(lastRunMs !== undefined ? { lastRunMs } : {}),
  };
}

function quarantine(file: string): void {
  const target = `${file}.corrupt-${Date.now()}`;
  try {
    renameSync(file, target);
    log.warn('watch registry: JSON ilegible, se aparta', { file, target });
  } catch (err) {
    log.warn('watch registry: JSON ilegible y no se pudo apartar', { file, err });
  }
}

function readAll(file: string, max: number): Watch[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    quarantine(file);
    return [];
  }

  let rows: unknown[];
  if (Array.isArray(parsed)) {
    rows = parsed;
  } else if (
    parsed &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { watches?: unknown }).watches)
  ) {
    // Tolerancia con versiones que envuelvan la lista; al escribir siempre usamos un array.
    rows = (parsed as { watches: unknown[] }).watches;
  } else {
    quarantine(file);
    return [];
  }

  const seen = new Set<string>();
  const watches: Watch[] = [];
  for (const row of rows) {
    const watch = fromStored(row);
    if (!watch || seen.has(watch.id)) {
      if (watch === null) log.warn('watch registry: registro inválido ignorado');
      continue;
    }
    seen.add(watch.id);
    watches.push(watch);
  }
  if (watches.length > max) {
    log.warn('watch registry: más registros que el tope, se conservan los más recientes', {
      found: watches.length,
      max,
    });
    return watches.slice(-max);
  }
  return watches;
}

function writeAll(file: string, watches: readonly Watch[]): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const body = `${JSON.stringify(watches, null, 2)}\n`;
  try {
    writeFileSync(temporary, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } catch (err) {
    rmSync(temporary, { force: true });
    throw err;
  }
}

/**
 * Registro persistido. La ruta y el reloj se inyectan para que los tests no toquen
 * el state dir real; en producción se usa la instancia por defecto de más abajo.
 */
export class WatchRegistry {
  readonly #file: string;
  readonly #now: () => number;
  readonly #max: number;

  constructor(fileOrOptions: string | WatchRegistryOptions = {}) {
    const options = typeof fileOrOptions === 'string' ? { file: fileOrOptions } : fileOrOptions;
    this.#file = options.file ?? registryFile();
    this.#now = options.now ?? Date.now;
    this.#max = Math.max(1, Math.trunc(options.max ?? MAX_WATCHES));
  }

  get file(): string {
    return this.#file;
  }

  /**
   * Añade una vigilancia. Si ya existe una con el mismo `id`, la actualiza. Si no
   * hay id pero coincide `kind + target + chatId + threadId`, se reconfigura la
   * existente en vez de duplicarla: dos avisos idénticos son ruido, no cobertura.
   */
  add(input: AddWatchInput): Watch {
    if (!isWatchKind(input.kind)) throw new Error('kind de vigilancia no válido');
    const target = cleanTarget(input.target);
    if (!target) throw new Error('la vigilancia necesita un target');
    const chatId = cleanChat(input.chatId);
    if (!chatId) throw new Error('la vigilancia necesita un chatId');
    if (input.schedule !== undefined && input.schedule !== null && !isSchedule(input.schedule)) {
      throw new Error(`schedule no válido: ${String(input.schedule)}`);
    }

    const watches = readAll(this.#file, this.#max);
    const now = this.#now();
    const note = cleanNote(input.note);
    const threadId = cleanChat(input.threadId) || undefined;
    const schedule = isSchedule(input.schedule) ? input.schedule : undefined;
    const explicitId = cleanId(input.id);

    const sameId = explicitId ? watches.findIndex((watch) => watch.id === explicitId) : -1;
    if (sameId >= 0) {
      const current = watches[sameId] as Watch;
      const updated: Watch = {
        ...current,
        kind: input.kind,
        target,
        chatId,
        enabled: input.enabled ?? current.enabled,
      };
      if (input.threadId !== undefined) {
        if (threadId) updated.threadId = threadId;
        else delete updated.threadId;
      }
      if (input.note !== undefined) {
        if (note !== undefined) updated.note = note;
        else delete updated.note;
      }
      if (input.schedule !== undefined) {
        if (schedule) updated.schedule = schedule;
        else delete updated.schedule;
      }
      watches[sameId] = updated;
      writeAll(this.#file, watches);
      return { ...updated };
    }

    const twin = watches.find(
      (watch) =>
        watch.kind === input.kind &&
        watch.target === target &&
        watch.chatId === chatId &&
        (watch.threadId ?? '') === (threadId ?? ''),
    );
    if (twin) {
      if (input.note !== undefined) {
        if (note !== undefined) twin.note = note;
        else delete twin.note;
      }
      if (input.schedule !== undefined) {
        if (schedule) twin.schedule = schedule;
        else delete twin.schedule;
      }
      if (input.enabled !== undefined) twin.enabled = input.enabled;
      writeAll(this.#file, watches);
      return { ...twin };
    }

    if (watches.length >= this.#max) {
      throw new Error(`ya hay ${this.#max} vigilancias; quita alguna antes de añadir otra`);
    }

    const createdAt = finiteMs(input.createdAt) ?? now;
    const watch: Watch = {
      id: explicitId || randomUUID(),
      kind: input.kind,
      target,
      ...(note ? { note } : {}),
      chatId,
      ...(threadId ? { threadId } : {}),
      ...(schedule ? { schedule } : {}),
      enabled: input.enabled ?? true,
      createdAt,
    };
    watches.push(watch);
    writeAll(this.#file, watches);
    return { ...watch };
  }

  list(filter: WatchFilter = {}): Watch[] {
    return readAll(this.#file, this.#max)
      .filter((watch) => filter.chatId === undefined || watch.chatId === filter.chatId)
      .filter((watch) => filter.threadId === undefined || watch.threadId === filter.threadId)
      .filter((watch) => filter.kind === undefined || watch.kind === filter.kind)
      .filter((watch) => filter.enabled === undefined || watch.enabled === filter.enabled)
      .map((watch) => ({ ...watch }));
  }

  remove(id: string): boolean {
    const watches = readAll(this.#file, this.#max);
    const kept = watches.filter((watch) => watch.id !== id);
    if (kept.length === watches.length) return false;
    writeAll(this.#file, kept);
    return true;
  }

  /** Marca una ejecución. El planificador la llama aunque el push no salga. */
  markRun(id: string, ms: number): boolean {
    if (!Number.isFinite(ms) || ms < 0) throw new Error('markRun necesita un instante válido');
    const watches = readAll(this.#file, this.#max);
    const watch = watches.find((candidate) => candidate.id === id);
    if (!watch) return false;
    watch.lastRunMs = ms;
    writeAll(this.#file, watches);
    return true;
  }

  /**
   * Vigilancias con schedule cuya siguiente ejecución ya llegó. Sin `lastRunMs`
   * nunca se han ejecutado, así que vencen en el acto. Sin schedule son manuales.
   */
  dueForPush(nowMs: number): Watch[] {
    if (!Number.isFinite(nowMs)) return [];
    const due: Array<{ watch: Watch; at: number }> = [];
    for (const watch of readAll(this.#file, this.#max)) {
      if (!watch.enabled || !watch.schedule) continue;
      const interval = SCHEDULE_MS[watch.schedule];
      const last = watch.lastRunMs ?? 0;
      const at = last + interval;
      if (at <= nowMs) due.push({ watch, at });
    }
    due.sort((a, b) => a.at - b.at || a.watch.createdAt - b.watch.createdAt);
    return due.map(({ watch }) => ({ ...watch }));
  }
}

let defaultRegistry: WatchRegistry | undefined;

function registry(): WatchRegistry {
  defaultRegistry ??= new WatchRegistry();
  return defaultRegistry;
}

/** API de módulo sobre `paths.state/watch/registry.json`. */
export function add(input: AddWatchInput): Watch {
  return registry().add(input);
}

export function list(filter: WatchFilter = {}): Watch[] {
  return registry().list(filter);
}

export function remove(id: string): boolean {
  return registry().remove(id);
}

export function markRun(id: string, ms: number): boolean {
  return registry().markRun(id, ms);
}

export function dueForPush(nowMs: number): Watch[] {
  return registry().dueForPush(nowMs);
}
