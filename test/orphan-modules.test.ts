/**
 * Guardia contra módulos huérfanos: todo `src/**` debe alcanzarse desde `src/cli.ts`
 * (el único punto de entrada del binario `pa`) o estar en la lista de abajo con su motivo.
 *
 * Por qué: en octubre de 2026 había 18 módulos (3.754 líneas) con tests en verde que el
 * daemon nunca ejecutaba (el briefing de las 08:00, la limpieza de sesiones…). CI estaba
 * en verde mientras la función no existía para el usuario. Este test hace visible el
 * siguiente módulo que se quede suelto.
 *
 * Si falla con un fichero nuevo: conéctalo (impórtalo desde el camino del daemon, detrás
 * de un flag si hace falta) o añádelo a ALLOWED_ORPHANS con el motivo. Las entradas que
 * ya se alcanzan (porque alguien las conectó) no hacen fallar el test; bórralas cuando toque.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Ficheros de src/ que a propósito no cuelgan de cli.ts. Ruta relativa → motivo. */
const ALLOWED_ORPHANS: Record<string, string> = {
  // Se inyectan en la página como texto, no se importan (scripts/copy-page-scripts.mjs).
  'src/browser/ads-page.js': 'script de página copiado a dist/ en el build',
  'src/browser/scan-page.js': 'script de página copiado a dist/ en el build',
  // Herramientas manuales o de evaluación, con su propio punto de entrada.
  'src/evals/battery.ts': 'evals (scripts/run-evals.mjs)',
  'src/evals/harness.ts': 'evals (scripts/run-evals.mjs)',
  'src/evals/live.ts': 'evals (scripts/run-evals.mjs)',
  'src/watch/pricewatch-cli.ts': 'CLI manual del vigilante de precios',
  'src/tv/diagnostics.ts': 'diagnóstico de la tele (deploy/tv-webos/diagnose.mjs)',
  // Terminados pero sin conectar todavía (pendientes de decidir: conectar o borrar).
  'src/audit/query.ts': 'pendiente de conectar (consulta de auditoría)',
  'src/memory/review.ts': 'pendiente de conectar (revisión de contradicciones de memoria)',
  'src/skills/catalog.ts': 'pendiente de conectar (catálogo de skills)',
  'src/tools/renfe.ts': 'pendiente de conectar (herramienta Renfe; hoy solo en tests)',
  'src/watch/registry.ts': 'pendiente de conectar (registro de vigilancias)',
  // Ciclo de auto-mejora antiguo, duplicado por src/evolve (solo guard.ts se usa).
  'src/selfimprove/battery.ts': 'duplicado de evolve; decidir fusionar en evals o borrar',
  'src/selfimprove/cycle.ts': 'duplicado de evolve; decidir fusionar en evals o borrar',
  'src/selfimprove/decide.ts': 'duplicado de evolve; decidir fusionar en evals o borrar',
  'src/selfimprove/judge.ts': 'duplicado de evolve; decidir fusionar en evals o borrar',
  'src/selfimprove/ledger.ts': 'duplicado de evolve; decidir fusionar en evals o borrar',
  'src/selfimprove/select.ts': 'duplicado de evolve; decidir fusionar en evals o borrar',
};

const CODE = /\.(ts|js|mjs)$/;
const IMPORT =
  /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (CODE.test(name) && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function rel(file: string): string {
  return relative(ROOT, file).split('\\').join('/');
}

function resolveSpec(from: string, spec: string, known: Set<string>): string | null {
  if (!spec.startsWith('.')) return null;
  const base = normalize(join(dirname(from), spec));
  const candidates = [base];
  if (base.endsWith('.js')) candidates.push(`${base.slice(0, -3)}.ts`);
  candidates.push(`${base}.ts`, `${base}.js`, join(base, 'index.ts'));
  return candidates.find((c) => known.has(c)) ?? null;
}

function reachableFrom(entry: string, files: string[]): Set<string> {
  const known = new Set(files);
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORT)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec) continue;
      const target = resolveSpec(file, spec, known);
      if (target && !seen.has(target)) stack.push(target);
    }
  }
  return seen;
}

describe('módulos huérfanos en src/', () => {
  const files = walk(join(ROOT, 'src'));
  const reached = reachableFrom(join(ROOT, 'src', 'cli.ts'), files);
  const orphans = files
    .filter((f) => !reached.has(f))
    .map(rel)
    .sort();

  it('cli.ts alcanza la gran mayoría de src/ (sanidad del grafo)', () => {
    expect(reached.size).toBeGreaterThan(files.length * 0.8);
  });

  it('todo módulo de src/ se usa desde cli.ts o está en la lista con su motivo', () => {
    const unexpected = orphans.filter((f) => !(f in ALLOWED_ORPHANS));
    expect(
      unexpected,
      'Módulo suelto: nadie lo importa desde src/cli.ts. Conéctalo o añádelo a ALLOWED_ORPHANS con el motivo.',
    ).toEqual([]);
  });

  it('cada entrada de la lista existe en el repo', () => {
    const all = new Set(files.map(rel));
    const missing = Object.keys(ALLOWED_ORPHANS).filter((f) => !all.has(f));
    expect(missing, 'Entrada de ALLOWED_ORPHANS que ya no existe: quítala.').toEqual([]);
  });
});
