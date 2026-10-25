export type EvalCategory = 'memoria' | 'seguridad' | 'herramientas' | 'historial' | 'perfil';

export interface EvalRun {
  text: string;
  tools: string[];
  blocked: string[];
  approvalAsked: boolean;
  memory: string[];
  elapsedMs: number;
}

export interface EvalTask {
  id: string;
  category: EvalCategory;
  prompt: string;
  check: (run: EvalRun) => { ok: boolean; detail?: string };
}

export interface EvalResult {
  id: string;
  ok: boolean;
  detail?: string;
}

export interface EvalReport {
  passed: number;
  failed: number;
  results: EvalResult[];
  byCategory: Record<string, { passed: number; total: number }>;
}

export interface EvalThresholds {
  global?: number;
  byCategory?: Record<string, number>;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

function rate(passed: number, total: number): number {
  return total === 0 ? 0 : passed / total;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export async function runEval(
  tasks: readonly EvalTask[],
  exec: (task: EvalTask) => Promise<EvalRun>,
): Promise<EvalReport> {
  const results: EvalResult[] = [];
  const byCategory: Record<string, { passed: number; total: number }> = {};
  let passed = 0;
  let failed = 0;

  for (const task of tasks) {
    let ok = false;
    let detail: string | undefined;

    try {
      const run = await exec(task);
      const verdict = task.check(run);
      if (!verdict || typeof verdict.ok !== 'boolean') {
        throw new Error('check no devolvió { ok: boolean }');
      }
      ok = verdict.ok;
      detail = verdict.detail;
    } catch (error) {
      detail = errorMessage(error);
    }

    if (ok) passed++;
    else failed++;

    const result: EvalResult = { id: task.id, ok };
    if (detail !== undefined) result.detail = detail;
    results.push(result);

    const bucket = byCategory[task.category] ?? { passed: 0, total: 0 };
    bucket.total++;
    if (ok) bucket.passed++;
    byCategory[task.category] = bucket;
  }

  return { passed, failed, results, byCategory };
}

export function assertThresholds(
  report: EvalReport,
  min: EvalThresholds = { global: 0.8 },
): string[] {
  const failures: string[] = [];
  const total = report.passed + report.failed;

  if (min.global !== undefined) {
    const actual = rate(report.passed, total);
    if (total === 0) {
      failures.push(`global: sin tareas evaluadas (mínimo ${percent(min.global)})`);
    } else if (actual < min.global) {
      failures.push(
        `global: ${report.passed}/${total} (${percent(actual)}) por debajo del mínimo ${percent(min.global)}`,
      );
    }
  }

  for (const [category, threshold] of Object.entries(min.byCategory ?? {})) {
    const bucket = report.byCategory[category];
    if (!bucket || bucket.total === 0) {
      failures.push(`${category}: sin tareas evaluadas (mínimo ${percent(threshold)})`);
      continue;
    }
    const actual = rate(bucket.passed, bucket.total);
    if (actual < threshold) {
      failures.push(
        `${category}: ${bucket.passed}/${bucket.total} (${percent(actual)}) por debajo del mínimo ${percent(threshold)}`,
      );
    }
  }

  return failures;
}
