// Puerta de la batería: el examen que un cambio de la auto-mejora tiene que aprobar.
// La suite de tests (measure.ts + score.ts) dice si el código mejora; la batería
// (selfimprove/battery.json, 74 casos) dice si el ASISTENTE sigue comportándose
// bien: pide permiso cuando toca, no inventa, no filtra. Un candidato solo se
// promueve si la batería no empeora y ningún caso que pasaba deja de pasar.
// Sin batería configurada no se promueve nada (falla cerrado).
import { type CaseResult, type Score, scoreRun } from './battery.js';
import {
  type Battery,
  type BatteryCase,
  judge as judgeCase,
  loadBattery,
  type Trace,
  toCaseResult,
  type Verdict,
} from './battery-judge.js';

/** Ruta de la batería dentro del repo. Protegida: el bucle no puede tocarla. */
export const BATTERY_FILE = 'selfimprove/battery.json';

/**
 * Ejecuta un caso contra el código que hay en `cwd` y devuelve su traza. Inyectado:
 * en tests es un modelo simulado; en producción, el comando de PA_EVOLVE_BATTERY.
 */
export type BatteryRunner = (c: BatteryCase, cwd: string) => Promise<Trace>;

export interface BatteryGate {
  cases: BatteryCase[];
  run: BatteryRunner;
  /** Repeticiones por caso; pasa por mayoría. */
  repeats?: number;
  now?: () => Date;
}

export interface BatteryRun {
  results: CaseResult[];
  score: Score;
}

/** Un caso puntúa solo si está activo, lo juzga la máquina y tiene criterios verificables. */
export function scorable(c: BatteryCase): boolean {
  if (c.enabled === false) return false;
  if (c.judge === 'qa' || c.judge === 'review') return false;
  return Object.keys(c.machine ?? {}).length > 0;
}

export function gateFromFile(path: string, run: BatteryRunner, repeats?: number): BatteryGate {
  const b: Battery = loadBattery(path);
  return { cases: b.cases, run, repeats };
}

/** Corre la batería. Un caso cuyo ejecutor falla cuenta como fallo, no como entorno. */
export async function measureBattery(g: BatteryGate, cwd: string): Promise<BatteryRun> {
  const repeats = Math.max(1, Math.floor(g.repeats ?? 3));
  const results: CaseResult[] = [];
  for (const c of g.cases.filter(scorable)) {
    const verdicts: Verdict[] = [];
    for (let i = 0; i < repeats; i++) {
      try {
        const trace = await g.run(c, cwd);
        verdicts.push(judgeCase(c, trace, g.now?.() ?? new Date()).verdict);
      } catch {
        verdicts.push('fail');
      }
    }
    results.push(toCaseResult(c.id, verdicts));
  }
  return { results, score: scoreRun(results) };
}

export interface BatteryVerdict {
  ok: boolean;
  reason: string;
  /** Casos que pasaban en la base y ya no pasan (o desaparecieron). */
  regressions: string[];
}

export const fmtBattery = (s: Score): string => `${s.passed}/${s.total}`;

/** Aprueba solo si nada que pasaba deja de pasar y la nota no baja. */
export function batteryVerdict(before: BatteryRun, after: BatteryRun): BatteryVerdict {
  const b = before.score;
  const a = after.score;
  if (a.total === 0) {
    return { ok: false, reason: 'la batería no puntuó ningún caso', regressions: [] };
  }
  const now = new Set(a.passing);
  const regressions = b.passing.filter((id) => !now.has(id));
  if (regressions.length) {
    return {
      ok: false,
      reason: `batería ${fmtBattery(a)} (antes ${fmtBattery(b)}): rompe casos que pasaban: ${regressions.join(', ')}`,
      regressions,
    };
  }
  if (a.rate < b.rate) {
    return {
      ok: false,
      reason: `batería ${fmtBattery(a)} por debajo de la base ${fmtBattery(b)}`,
      regressions,
    };
  }
  return {
    ok: true,
    reason: `batería ${fmtBattery(a)} (antes ${fmtBattery(b)}), sin regresiones`,
    regressions,
  };
}
