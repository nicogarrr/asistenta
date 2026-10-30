import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Cohesión: todo módulo de `src/` debe estar conectado al binario `pa` (alcanzable
 * por imports desde `src/cli.ts`) o figurar aquí con el motivo. Antes había 18 módulos
 * terminados y testeados que el daemon no usaba nunca (el resumen de las 08:00, la
 * retención de sesiones…) y CI no se enteraba. Si añades un módulo y este test falla:
 * conéctalo al daemon/router, o añádelo aquí con una razón honesta.
 */
const KNOWN_UNWIRED: Record<string, string> = {
  'src/evals/battery.ts': 'solo evals (scripts/run-evals.mjs), no es del daemon',
  'src/evals/harness.ts': 'solo evals (scripts/run-evals.mjs), no es del daemon',
  'src/evals/live.ts': 'solo evals (scripts/run-evals.mjs), no es del daemon',
  'src/tools/renfe.ts':
    'herramienta usada solo por las evals; falta decidir si se ofrece al agente',
  'src/watch/pricewatch-cli.ts': 'script suelto del vigilante de precios; candidato a `pa precio`',
  'src/memory/review.ts':
    'cola de contradicciones; falta quien la llene (consolidación) y un comando para resolverla',
  'src/skills/catalog.ts': 'catálogo de skills; falta comando /skills catalogo (descarga remota)',
  'src/watch/registry.ts':
    'registro único de vigilancias; pendiente de unificar los 5 tipos (plan P3 de ARCHITECTURE)',
  'src/tv/diagnostics.ts': 'rescate telnet de la tele (#145), solo manual; no se toca la TV',
  'src/selfimprove/battery.ts': 'duplicado de evolve (plan P6: fusionar o borrar)',
  'src/selfimprove/cycle.ts': 'duplicado de evolve (plan P6: fusionar o borrar)',
  'src/selfimprove/decide.ts': 'duplicado de evolve (plan P6: fusionar o borrar)',
  'src/selfimprove/judge.ts': 'duplicado de evolve (plan P6: fusionar o borrar)',
  'src/selfimprove/ledger.ts': 'duplicado de evolve (plan P6: fusionar o borrar)',
  'src/selfimprove/select.ts': 'duplicado de evolve (plan P6: fusionar o borrar)',
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return p.endsWith('.ts') && !p.endsWith('.d.ts') ? [p] : [];
  });
}

const posix = (p: string): string => p.split('\\').join('/');
const SPEC = /(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g;

function reachableFrom(entry: string, all: Set<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const m of readFileSync(file, 'utf8').matchAll(SPEC)) {
      const base = posix(normalize(join(dirname(file), m[1] as string)));
      const target = [base.replace(/\.js$/, '.ts'), `${base}.ts`, `${base}/index.ts`].find((c) =>
        all.has(c),
      );
      if (target && !seen.has(target)) stack.push(target);
    }
  }
  return seen;
}

describe('módulos sueltos (no conectados a `pa`)', () => {
  const all = new Set(walk('src').map((p) => posix(relative('.', p))));
  const reachable = reachableFrom('src/cli.ts', all);
  const unwired = [...all].filter((f) => !reachable.has(f)).sort();

  it('cada módulo de src/ está conectado o explicado en KNOWN_UNWIRED', () => {
    expect(unwired.filter((f) => !(f in KNOWN_UNWIRED))).toEqual([]);
  });

  it('el grafo encuentra los módulos cableados (briefing, mantenimiento, auditoría)', () => {
    for (const f of ['src/maintenance.ts', 'src/audit/audit-cli.ts', 'src/audit/query.ts']) {
      expect(reachable.has(f), f).toBe(true);
    }
  });
});
