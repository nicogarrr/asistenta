import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guarda de cohesión (plan de unificación, P0): ningún módulo nuevo de src/ puede
 * quedarse «suelto», es decir, terminado y con tests pero sin que nada que arranca
 * Asistenta lo importe. Así nacieron el resumen de la mañana, la retención, el registro
 * de vigilancias y otros: código que existía y no se ejecutaba nunca.
 *
 * Cómo funciona: sigue los imports (estáticos, `export … from` e `import('…')`) desde
 * los puntos de entrada y lista los .ts de src/ a los que no se llega.
 *
 * Si este test falla por un módulo tuyo: impórtalo desde donde se use (detrás de un
 * interruptor apagado si añade riesgo) o, si de verdad es una herramienta aparte, añade
 * su fichero a ENTRY_POINTS. KNOWN_ORPHANS solo puede encoger: al cablear uno, quítalo.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Lo que arranca de verdad: el CLI (daemon incluido) y la herramienta manual de precios. */
const ENTRY_POINTS = ['cli.ts', 'watch/pricewatch-cli.ts'];

/** Sueltos conocidos el 30-oct-2026 (ver ARCHITECTURE.md). Esta lista solo encoge. */
const KNOWN_ORPHANS = new Set([
  'audit/query.ts',
  'evals/battery.ts',
  'evals/harness.ts',
  'evals/live.ts',
  'memory/review.ts',
  'selfimprove/battery.ts',
  'selfimprove/cycle.ts',
  'selfimprove/decide.ts',
  'selfimprove/judge.ts',
  'selfimprove/ledger.ts',
  'selfimprove/select.ts',
  'skills/catalog.ts',
  'tools/renfe.ts',
  'tv/diagnostics.ts',
  'watch/registry.ts',
]);

const IMPORT_RE =
  /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function resolveSpec(from: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined;
  const base = normalize(join(dirname(from), spec));
  for (const c of [base.replace(/\.js$/, '.ts'), base, `${base}.ts`, join(base, 'index.ts')]) {
    if (c.endsWith('.ts') && existsSync(c)) return c;
  }
  return undefined;
}

function findOrphans(): string[] {
  const files = walk(SRC);
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const deps: string[] = [];
    for (const m of text.matchAll(IMPORT_RE)) {
      const target = resolveSpec(file, m[1] ?? m[2] ?? m[3] ?? '');
      if (target) deps.push(target);
    }
    graph.set(file, deps);
  }
  const seen = new Set<string>();
  const stack = ENTRY_POINTS.map((e) => join(SRC, e));
  while (stack.length) {
    const next = stack.pop() as string;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(graph.get(next) ?? []));
  }
  return files
    .filter((f) => !seen.has(f))
    .map((f) => relative(SRC, f).split('\\').join('/'))
    .sort();
}

describe('cohesión: sin módulos sueltos nuevos', () => {
  it('los puntos de entrada existen', () => {
    for (const e of ENTRY_POINTS) expect(existsSync(join(SRC, e)), e).toBe(true);
  });

  it('el grafo llega al núcleo y a las capacidades que funcionan (computer use, tele)', () => {
    const orphans = new Set(findOrphans());
    for (const live of [
      'core/agent.ts',
      'core/tool-registry.ts',
      'tools/computer.ts',
      'screen/windows.ts',
      'tools/tv.ts',
      'tv/lgtv.ts',
      'permissions.ts',
    ]) {
      expect(orphans.has(live), `${live} debería estar cableado`).toBe(false);
    }
  });

  it('ningún módulo de src/ fuera de la lista conocida queda sin importar', () => {
    const fresh = findOrphans().filter((f) => !KNOWN_ORPHANS.has(f));
    expect(
      fresh,
      `Módulos sueltos nuevos (nadie que arranque Asistenta los importa): ${fresh.join(', ')}`,
    ).toEqual([]);
  });
});
