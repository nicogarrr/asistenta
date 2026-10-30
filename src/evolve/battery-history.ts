// Historial por caso de la batería, una hoja por semana ISO (evolve-historial/AAAA-Www.json).
// Solo se anota la base (el kernel): si un caso que depende de webs de fuera (external)
// falla en la base tres semanas seguidas, el fallo es del sitio, no del asistente, y el
// caso se aparta: deja de correr y de puntuar, y /evolucion lo cuenta. Cada 4 semanas
// vuelve a correr una vez; si sigue fallando, se aparta otra vez.
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isoWeek } from './archive.js';
import { type CaseResult, casePasses } from './battery.js';
import type { BatteryCase } from './battery-judge.js';

/** Carpeta del estado (registrada en src/state-files.ts, con poda por antigüedad). */
export const HISTORY_DIR = 'evolve-historial';
export const WEEK_FILE = /^\d{4}-W\d{2}\.json$/;
/** Semanas seguidas fallando en la base para apartar un caso externo. */
export const FAILING_WEEKS = 3;
/** Semanas que dura el apartado antes de volver a probar el caso. */
export const RETRY_AFTER_WEEKS = 4;

type Week = Record<string, 'pass' | 'fail'>;

function readWeek(file: string): Week {
  try {
    const v: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Week = {};
    for (const [id, r] of Object.entries(v)) if (r === 'pass' || r === 'fail') out[id] = r;
    return out;
  } catch {
    return {};
  }
}

/** Anota los resultados de la base en la hoja de esta semana. Un pase en la semana manda. */
export function recordBaseWeek(dir: string, results: CaseResult[], now = new Date()): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${isoWeek(now)}.json`);
  const week = readWeek(file);
  for (const r of results) {
    if (week[r.caseId] === 'pass') continue;
    week[r.caseId] = casePasses(r) ? 'pass' : 'fail';
  }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(week, null, 2)}\n`);
  renameSync(tmp, file);
}

/** Lunes (UTC) de la semana ISO `AAAA-Www`, en semanas desde la época. */
export function weekNumber(label: string): number {
  const [y, w] = label.split('-W').map(Number) as [number, number];
  const jan4 = Date.UTC(y, 0, 4);
  const monday = jan4 - ((new Date(jan4).getUTCDay() || 7) - 1) * 86_400_000;
  return Math.round((monday + (w - 1) * 7 * 86_400_000) / (7 * 86_400_000));
}

/**
 * Casos externos apartados: sus últimas FAILING_WEEKS semanas anotadas fallan todas y
 * la última es de hace menos de RETRY_AFTER_WEEKS semanas. Los no externos nunca se
 * apartan: si fallan, es cosa del asistente y tienen que seguir contando.
 */
export function quarantinedCases(
  dir: string,
  cases: Pick<BatteryCase, 'id' | 'external'>[],
  now = new Date(),
): Set<string> {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => WEEK_FILE.test(f));
  } catch {
    return new Set();
  }
  const weeks = files
    .map((f) => ({ n: weekNumber(f.slice(0, -5)), data: readWeek(join(dir, f)) }))
    .sort((a, b) => b.n - a.n);
  const current = weekNumber(isoWeek(now));
  const out = new Set<string>();
  for (const c of cases) {
    if (c.external !== true) continue;
    const seen = weeks.filter((w) => w.data[c.id] !== undefined).slice(0, FAILING_WEEKS);
    if (seen.length < FAILING_WEEKS || seen.some((w) => w.data[c.id] !== 'fail')) continue;
    if (current - (seen[0] as { n: number }).n < RETRY_AFTER_WEEKS) out.add(c.id);
  }
  return out;
}
