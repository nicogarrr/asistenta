/**
 * ¿Está Asistenta haciendo algo ahora mismo? Lo necesita la autoactualización (autoupdate.ts)
 * para no reiniciar el daemon en mitad de un turno o con una aprobación esperando a Nico.
 *
 * El daemon llama a trackBusyIn() al arrancar y cada turno/aprobación abre y cierra un
 * contador con busyBegin(). Se escribe un fichero pequeño que lee otro proceso (el que
 * actualiza). Fuera del daemon (tests, CLI) no se escribe nada.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileReplacing } from './fs-tmp.js';

export const BUSY_DIR = 'autoupdate';
export const BUSY_FILE = 'ocupada.json';
export type BusyKind = 'turnos' | 'aprobaciones';
export type BusyState = 'libre' | 'ocupada' | 'desconocido';

const counts: Record<BusyKind, number> = { turnos: 0, aprobaciones: 0 };
let target: string | undefined;

/** Un turno o aprobación abierto: qué es y desde cuándo (para decir qué espera y detectar los colgados). */
export interface BusyItem {
  kind: BusyKind;
  label: string;
  since: string;
}
const open = new Set<BusyItem>();
let interrupted: BusyItem[] = [];

/** Tareas que el cierre anterior cortó a medias (hasta que el dueño las retome o descarte). */
export function interruptedTasks(): BusyItem[] {
  return interrupted;
}

/** Descarta la lista de cortadas (ya se avisó y se retomaron o se dejaron). */
export function clearInterrupted(): void {
  interrupted = [];
}

/** Turnos y permisos abiertos en este proceso ahora mismo. */
export function openBusyItems(): BusyItem[] {
  return [...open];
}

/** Pasado este tiempo, un turno o permiso abierto se considera colgado y no frena la actualización. */
export function busyMaxMs(env: NodeJS.ProcessEnv = process.env): number {
  const min = Number(env.PA_BUSY_MAX_MIN);
  return (Number.isFinite(min) && min > 0 ? min : 30) * 60_000;
}

function write(): void {
  if (!target) return;
  try {
    writeFileReplacing(
      target,
      JSON.stringify({
        pid: process.pid,
        ...counts,
        items: [...open],
        at: new Date().toISOString(),
      }),
    );
  } catch {
    // Sin fichero, la autoactualización lo lee como «no sé» y espera: nunca reinicia a ciegas.
  }
}

/** El daemon, al arrancar: desde aquí cada cambio de los contadores queda en disco. */
export function trackBusyIn(stateDir: string): BusyItem[] {
  try {
    mkdirSync(join(stateDir, BUSY_DIR), { recursive: true });
  } catch {
    return [];
  }
  target = join(stateDir, BUSY_DIR, BUSY_FILE);
  // Lo que había abierto cuando murió el proceso anterior: tareas cortadas por el cierre.
  const cut = previousOpenItems(target);
  interrupted = cut;
  write();
  return cut;
}

function previousOpenItems(file: string): BusyItem[] {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown; items?: unknown };
    if (raw.pid === process.pid || !Array.isArray(raw.items)) return [];
    return raw.items.filter(
      (i): i is BusyItem =>
        !!i && typeof i.label === 'string' && typeof i.since === 'string' && i.kind === 'turnos',
    );
  } catch {
    return [];
  }
}

/** Abre un turno o una aprobación; la función devuelta lo cierra (una sola vez). */
export function busyBegin(kind: BusyKind, label = ''): () => void {
  counts[kind] += 1;
  const item: BusyItem = { kind, label: label.slice(0, 80), since: new Date().toISOString() };
  open.add(item);
  write();
  let isOpen = true;
  return () => {
    if (!isOpen) return;
    isOpen = false;
    open.delete(item);
    counts[kind] = Math.max(0, counts[kind] - 1);
    write();
  };
}

export interface BusyDetail {
  state: BusyState;
  /** Abiertos y recientes: lo que de verdad se está esperando. */
  items: BusyItem[];
  /** Abiertos desde hace más del tope: colgados, no frenan la actualización. */
  hung: BusyItem[];
}

/** Estado de ocupada con el detalle de qué espera y qué lleva demasiado tiempo abierto. */
export function readBusyDetail(
  stateDir: string,
  now: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): BusyDetail {
  try {
    const raw = JSON.parse(readFileSync(join(stateDir, BUSY_DIR, BUSY_FILE), 'utf8')) as Record<
      string,
      unknown
    >;
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN);
    const turnos = n(raw.turnos);
    const aprobaciones = n(raw.aprobaciones);
    if (Number.isNaN(turnos) || Number.isNaN(aprobaciones)) {
      return { state: 'desconocido', items: [], hung: [] };
    }
    const all = Array.isArray(raw.items)
      ? (raw.items as BusyItem[]).filter((i) => i && typeof i.since === 'string')
      : [];
    const max = busyMaxMs(env);
    const hung = all.filter((i) => now - Date.parse(i.since) > max);
    const items = all.filter((i) => !hung.includes(i));
    // Contadores sin detalle (fichero de una versión anterior): se fía de los contadores.
    const legacy = all.length === 0 && (turnos > 0 || aprobaciones > 0);
    return { state: legacy || items.length > 0 ? 'ocupada' : 'libre', items, hung };
  } catch {
    return { state: 'desconocido', items: [], hung: [] };
  }
}

export function readBusy(stateDir: string): BusyState {
  return readBusyDetail(stateDir).state;
}

/** Frase con lo que espera, p. ej. «un turno desde hace 4 min («instala HyperHDR»)». */
export function describeBusy(items: BusyItem[], now: number = Date.now()): string {
  return items
    .map((i) => {
      const min = Math.max(0, Math.round((now - Date.parse(i.since)) / 60_000));
      const what = i.kind === 'aprobaciones' ? 'un permiso sin responder' : 'una tarea';
      return `${what} desde hace ${min} min${i.label ? ` («${i.label}»)` : ''}`;
    })
    .join(', ');
}
