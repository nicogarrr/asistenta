/**
 * Resultado de la última comprobación de arranque (`pa iniciar`), guardado en
 * `<estado>/iniciar-ultimo.json` para que `pa autostart status` diga si el
 * último arranque estaba en verde o qué falló, sin volver a comprobarlo todo.
 *
 * Guardarlo nunca puede impedir arrancar: cualquier error se ignora.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PreflightCheck } from './preflight.js';

export const STARTUP_RECORD_FILE = 'iniciar-ultimo.json';

export interface StartupRecord {
  /** ISO de cuándo se comprobó. */
  at: string;
  /** Sin ningún ❌. */
  ok: boolean;
  /** Etiquetas de lo marcado con ❌. */
  fallos: string[];
  /** Etiquetas de lo marcado con ⚠️. */
  avisos: string[];
}

export function startupRecordFrom(checks: readonly PreflightCheck[], now: Date): StartupRecord {
  const fallos = checks.filter((c) => c.status === 'fallo').map((c) => c.label);
  const avisos = checks.filter((c) => c.status === 'aviso').map((c) => c.label);
  return { at: now.toISOString(), ok: fallos.length === 0, fallos, avisos };
}

export function saveStartupRecord(
  path: string,
  checks: readonly PreflightCheck[],
  now: Date = new Date(),
): void {
  const tmp = `${path}.${process.pid}.${now.getTime()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(startupRecordFrom(checks, now)));
    renameSync(tmp, path);
  } catch {
    // Solo es un diagnóstico: arrancar importa más que recordarlo. Pero sin dejar
    // un .tmp por arranque si el rename falla (en Windows, fichero abierto).
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Ni el .tmp se puede quitar: no hay nada más que hacer.
    }
  }
}

const isLabels = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

export function readStartupRecord(path: string): StartupRecord | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<StartupRecord>;
    if (
      typeof raw.at !== 'string' ||
      Number.isNaN(Date.parse(raw.at)) ||
      typeof raw.ok !== 'boolean' ||
      !isLabels(raw.fallos) ||
      !isLabels(raw.avisos)
    ) {
      return undefined;
    }
    return { at: raw.at, ok: raw.ok, fallos: raw.fallos, avisos: raw.avisos };
  } catch {
    return undefined;
  }
}

/** «hace 5 min», «hace 3 h»… desde una fecha ISO. */
export function ago(at: string, now: Date): string {
  const atMs = Date.parse(at);
  if (Number.isNaN(atMs)) return 'en fecha desconocida';
  const future = futureDated(atMs, now.getTime());
  if (future) return future;
  const min = Math.max(0, Math.round((now.getTime() - atMs) / 60_000));
  if (min < 1) return 'hace un momento';
  return `hace ${span(min)}`;
}

/** El texto con un solo punto final, aunque ya traiga el suyo. */
export function withPeriod(text: string): string {
  return `${text.replace(/[.\s]+$/, '')}.`;
}

/** «5 min», «3 h», «2 días». */
export function span(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} días`;
}

/**
 * Una fecha guardada más de 1 min por delante del reloj (el reloj se atrasó
 * después: hora corregida, arranque dual) no es «hace un momento»: se dice.
 */
export function futureDated(atMs: number, nowMs: number): string | undefined {
  const min = Math.round((atMs - nowMs) / 60_000);
  return min >= 1 ? `con fecha futura (dentro de ${span(min)}; ¿se cambió el reloj?)` : undefined;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Una línea para `pa autostart status`. */
export function formatStartupRecord(
  rec: StartupRecord | undefined,
  now: Date = new Date(),
): string {
  const head = 'Última comprobación de arranque (pa iniciar)';
  if (!rec) return `${head}: ninguna guardada todavía. Pruébala con «pa iniciar --solo-comprobar».`;
  const when = ago(rec.at, now);
  const warn = rec.avisos.length
    ? `; ${plural(rec.avisos.length, 'aviso', 'avisos')}: ${rec.avisos.join(', ')}`
    : '';
  if (rec.ok) return `${head}, ${when}: todo en verde ✅${warn}.`;
  return `${head}, ${when}: ❌ ${plural(rec.fallos.length, 'fallo', 'fallos')}: ${rec.fallos.join(', ')}${warn}. Detalle y arreglo: «pa iniciar --solo-comprobar».`;
}
