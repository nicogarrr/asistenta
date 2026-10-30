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

function write(): void {
  if (!target) return;
  try {
    writeFileReplacing(
      target,
      JSON.stringify({ pid: process.pid, ...counts, at: new Date().toISOString() }),
    );
  } catch {
    // Sin fichero, la autoactualización lo lee como «no sé» y espera: nunca reinicia a ciegas.
  }
}

/** El daemon, al arrancar: desde aquí cada cambio de los contadores queda en disco. */
export function trackBusyIn(stateDir: string): void {
  try {
    mkdirSync(join(stateDir, BUSY_DIR), { recursive: true });
  } catch {
    return;
  }
  target = join(stateDir, BUSY_DIR, BUSY_FILE);
  write();
}

/** Abre un turno o una aprobación; la función devuelta lo cierra (una sola vez). */
export function busyBegin(kind: BusyKind): () => void {
  counts[kind] += 1;
  write();
  let open = true;
  return () => {
    if (!open) return;
    open = false;
    counts[kind] = Math.max(0, counts[kind] - 1);
    write();
  };
}

export function readBusy(stateDir: string): BusyState {
  try {
    const raw = JSON.parse(readFileSync(join(stateDir, BUSY_DIR, BUSY_FILE), 'utf8')) as Record<
      string,
      unknown
    >;
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN);
    const turnos = n(raw.turnos);
    const aprobaciones = n(raw.aprobaciones);
    if (Number.isNaN(turnos) || Number.isNaN(aprobaciones)) return 'desconocido';
    return turnos > 0 || aprobaciones > 0 ? 'ocupada' : 'libre';
  } catch {
    return 'desconocido';
  }
}
