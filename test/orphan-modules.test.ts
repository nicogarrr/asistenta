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
  'src/evolve/battery-case.ts':
    'evaluador de la batería: lo carga scripts/evolve-battery-case.mjs en la copia que se mide',
  'src/evolve/battery-case-env.ts':
    'lector del caso de la batería: scripts/evolve-battery-case.mjs lo carga antes que el asistente',
  'src/evals/battery.ts': 'solo evals (scripts/run-evals.mjs), no es del daemon',
  'src/evals/harness.ts': 'solo evals (scripts/run-evals.mjs), no es del daemon',
  'src/evals/live.ts': 'solo evals (scripts/run-evals.mjs), no es del daemon',
  'src/tools/renfe.ts':
    'herramienta usada solo por las evals; falta decidir si se ofrece al agente',
  'src/tv/diagnostics.ts': 'rescate telnet de la tele (#145), solo manual; no se toca la TV',
  'src/google/oauth.ts':
    'primera pieza de Google OAuth (PKCE); el comando `pa google conectar|estado|desconectar` la conecta en la siguiente PR',
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return p.endsWith('.ts') && !p.endsWith('.d.ts') ? [p] : [];
  });
}

const posix = (p: string): string => p.split('\\').join('/');
// Estáticos (`import … from`, `export … from`), dinámicos (`import('…')`) y de efecto (`import '…'`).
const SPEC =
  /(?:import|export)\s[^'"`;]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|import\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)|import\s+['"](\.{1,2}\/[^'"]+)['"]/g;

function reachableFrom(entry: string, all: Set<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const m of readFileSync(file, 'utf8').matchAll(SPEC)) {
      const base = posix(normalize(join(dirname(file), (m[1] ?? m[2] ?? m[3]) as string)));
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

  it('KNOWN_UNWIRED solo encoge: al cablear o borrar un módulo, quita su entrada', () => {
    const stale = Object.keys(KNOWN_UNWIRED).filter((f) => !all.has(f) || reachable.has(f));
    expect(stale, `entradas que sobran en KNOWN_UNWIRED: ${stale.join(', ')}`).toEqual([]);
  });

  it('el grafo llega al núcleo, a lo cableado y a lo que funciona (computer use, tele)', () => {
    for (const f of [
      'src/core/agent.ts',
      'src/core/tool-registry.ts',
      'src/permissions.ts',
      'src/tools/computer.ts',
      'src/screen/windows.ts',
      'src/tools/tv.ts',
      'src/tv/lgtv.ts',
      'src/maintenance.ts',
      'src/audit/audit-cli.ts',
      'src/audit/query.ts',
    ]) {
      expect(reachable.has(f), `${f} debería estar cableado`).toBe(true);
    }
  });
});
