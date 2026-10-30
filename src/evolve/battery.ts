// Bateria de pruebas y su puntuacion. Funciones puras: sin red ni disco.
// La bateria (prompts + criterio de pasada) es la REGLA DE MEDIR: el bucle de
// auto-mejora no puede modificarla (ver guard.ts).

export type CaseResult = {
  caseId: string;
  /** Una entrada por repeticion: true = paso el criterio. */
  runs: boolean[];
  /** Metrica secundaria opcional (p. ej. tokens). Solo informativa. */
  cost?: number;
};

export type Score = {
  total: number;
  passed: number;
  /** passed/total en [0,1]. */
  rate: number;
  /** Casos que pasan (mayoria de repeticiones). */
  passing: string[];
  failing: string[];
  /** Casos inestables: ni todas verdes ni todas rojas. */
  flaky: string[];
};

/** Un caso pasa si mas de la mitad de sus repeticiones pasan. Sin repeticiones = falla. */
export function casePasses(r: CaseResult): boolean {
  if (r.runs.length === 0) return false;
  return r.runs.filter(Boolean).length * 2 > r.runs.length;
}

export function isFlaky(r: CaseResult): boolean {
  const ok = r.runs.filter(Boolean).length;
  return ok > 0 && ok < r.runs.length;
}

export function scoreRun(results: CaseResult[]): Score {
  const passing: string[] = [];
  const failing: string[] = [];
  const flaky: string[] = [];
  for (const r of results) {
    (casePasses(r) ? passing : failing).push(r.caseId);
    if (isFlaky(r)) flaky.push(r.caseId);
  }
  const total = results.length;
  return {
    total,
    passed: passing.length,
    rate: total === 0 ? 0 : passing.length / total,
    passing,
    failing,
    flaky,
  };
}
