// Registro de cada ciclo: JSONL (maquina) + resumen en espanol (Nico).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Score } from './battery.js';
import type { Verdict } from './decide.js';

export type Attempt = {
  attempt: number;
  idea: string;
  patchSha256?: string;
  blocked?: string; // el guard lo rechazo
  before?: Score;
  after?: Score;
  verdict?: Verdict;
  error?: string;
  /** Casos que fallaban en la linea base de este intento (para detectar roturas de sitios externos). */
  baselineFailing?: string[];
};

export type CycleEntry = {
  cycleId: string;
  startedAt: string;
  topic: string;
  attempts: Attempt[];
  outcome: 'promoted' | 'dropped' | 'error';
  note: string;
};

export function appendCycle(path: string, e: CycleEntry): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(path, `${JSON.stringify(e)}\n`);
}

export function readCycles(path: string): CycleEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as CycleEntry];
      } catch {
        return []; // linea corrupta: se ignora, no se inventa
      }
    });
}

const fmt = (s?: Score) =>
  s ? `${s.passed}/${s.total} (${(s.rate * 100).toFixed(1)}%)` : 'sin medir';

export function renderCycle(e: CycleEntry): string {
  const head = { promoted: 'SUBIDO', dropped: 'DESCARTADO', error: 'ERROR' }[e.outcome];
  const lines = [`Ciclo ${e.cycleId} (${e.startedAt}) - ${e.topic}: ${head}`, e.note];
  for (const a of e.attempts) {
    const res = a.blocked
      ? `bloqueado por seguridad: ${a.blocked}`
      : a.error
        ? `error: ${a.error}`
        : `antes ${fmt(a.before)} -> despues ${fmt(a.after)}; ${a.verdict?.action ?? '?'}: ${a.verdict?.reason ?? ''}`;
    lines.push(`  intento ${a.attempt}: ${a.idea} | ${res}`);
  }
  return lines.join('\n');
}

/** Temas ya descartados: no se repiten tal cual en ciclos siguientes. */
export function droppedTopics(cycles: CycleEntry[]): Set<string> {
  return new Set(cycles.filter((c) => c.outcome === 'dropped').map((c) => c.topic));
}

/**
 * Casos externos que fallan en la linea base en cada uno de los ultimos `n` ciclos:
 * el sitio cambio o cayo. Van a revision manual, no se puntuan y el bucle no los "arregla".
 */
export function quarantinedCases(
  cycles: CycleEntry[],
  externalIds: Set<string>,
  n = 3,
): Set<string> {
  const recent = cycles.filter((c) => c.attempts.some((a) => a.baselineFailing)).slice(-n);
  const out = new Set<string>();
  if (recent.length < n) return out;
  for (const id of externalIds) {
    const failsAll = recent.every((c) => {
      const a = c.attempts.find((x) => x.baselineFailing);
      return a?.baselineFailing?.includes(id);
    });
    if (failsAll) out.add(id);
  }
  return out;
}
