import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INERT_TOOLS, WORKSPACE_TOOLS } from '../src/evolve/battery-case.js';

/**
 * Los casos de la batería exigen o prohíben llamadas por nombre (`herramienta` o
 * `herramienta.accion`, como las registra el evaluador). Un nombre que el asistente no
 * tiene hace el caso imposible de aprobar (requireCall) o inútil (forbidCall), y la
 * puerta de evolve deja de ver regresiones en él. Este test lee las herramientas
 * reales en src/ (name + label de cada AgentTool y sus acciones `action`) y exige que
 * cada nombre citado en evolve/battery.json case con al menos una de ellas.
 */

const ROOT = process.cwd();

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Nombres que puede registrar el evaluador: `tool` y `tool.accion` por cada acción declarada. */
function agentCallNames(): Set<string> {
  // src/evolve/ es el evaluador, no el asistente: sus herramientas de prueba no cuentan.
  const files = tsFiles(join(ROOT, 'src'))
    .filter((f) => !f.replace(/\\/g, '/').includes('/src/evolve/'))
    .map((f) => readFileSync(f, 'utf8'));
  const consts = new Map<string, string>();
  for (const src of files)
    for (const m of src.matchAll(/export const (\w+_TOOL_NAME) = '([\w.-]+)'/g))
      consts.set(m[1] as string, m[2] as string);
  const names = new Set<string>();
  for (const src of files) {
    const defined: string[] = [];
    for (const m of src.matchAll(/\n\s+name: ([^\n]+),\n\s+label:/g)) {
      const raw = (m[1] as string).trim();
      const name = /^'[\w.-]+'$/.test(raw) ? raw.slice(1, -1) : consts.get(raw);
      if (name) defined.push(name);
    }
    if (defined.length === 0) continue;
    const union = /action: Type\.Union\(\[([\s\S]*?)\]/.exec(src)?.[1] ?? '';
    const actions = [...union.matchAll(/Literal\('([\w-]+)'\)/g)].map((a) => a[1] as string);
    for (const n of defined) {
      names.add(n);
      for (const a of actions) names.add(`${n}.${a}`);
    }
  }
  return names;
}

interface Machine {
  requireCall?: string[];
  forbidCall?: { tool: string }[];
  maxCalls?: { tool: string }[];
}

function citedPatterns(): { id: string; field: string; pattern: string }[] {
  const battery = JSON.parse(readFileSync(join(ROOT, 'evolve/battery.json'), 'utf8')) as {
    cases: { id: string; machine: Machine }[];
  };
  const out: { id: string; field: string; pattern: string }[] = [];
  for (const c of battery.cases) {
    for (const p of c.machine.requireCall ?? [])
      out.push({ id: c.id, field: 'requireCall', pattern: p });
    for (const f of c.machine.forbidCall ?? [])
      out.push({ id: c.id, field: 'forbidCall', pattern: f.tool });
    for (const f of c.machine.maxCalls ?? [])
      out.push({ id: c.id, field: 'maxCalls', pattern: f.tool });
  }
  return out;
}

describe('batería: nombres de herramienta reales', () => {
  const names = agentCallNames();

  it('el registro leído de src/ tiene las herramientas conocidas (el escáner funciona)', () => {
    for (const n of [
      'reminder.create',
      'reminder.cancel',
      'memory.remember',
      'objetivo.proponer',
      'read',
      'write',
      'web.search',
      'checkout.confirm',
    ])
      expect(names.has(n), n).toBe(true);
    for (const n of ['cron.create', 'calendar.create', 'memory.write', 'fs.write', 'mail.send'])
      expect(names.has(n), n).toBe(false);
  });

  it('cada llamada exigida o prohibida en evolve/battery.json existe en el asistente', () => {
    const cited = citedPatterns();
    expect(cited.length).toBeGreaterThan(20);
    const missing = cited
      .filter(({ pattern }) => {
        const re = new RegExp(`^(${pattern})$`);
        return ![...names].some((n) => re.test(n));
      })
      .map(({ id, field, pattern }) => `${id} ${field} /${pattern}/`);
    expect(missing).toEqual([]);
  });

  it('cada herramienta que ofrece el evaluador existe en el asistente con ese nombre', () => {
    const runner = [...INERT_TOOLS, ...WORKSPACE_TOOLS, 'memory', 'reminder'];
    expect(runner.filter((n) => !names.has(n))).toEqual([]);
  });

  it('el texto qa (para humanos) cita herramientas que existen, no nombres viejos', () => {
    const battery = JSON.parse(readFileSync(join(ROOT, 'evolve/battery.json'), 'utf8')) as {
      cases: { id: string; qa?: { requireCall?: string[]; forbidCall?: string[] } }[];
    };
    const bad: string[] = [];
    for (const c of battery.cases)
      for (const t of [...(c.qa?.requireCall ?? []), ...(c.qa?.forbidCall ?? [])]) {
        for (const m of t.matchAll(/(?<![\w@.-])([a-z_]+\.[a-z_]+)(?![\w@.-])/g))
          if (!names.has(m[1] as string)) bad.push(`${c.id}: ${m[1]}`);
        for (const m of t.matchAll(/\b(mail|fs|calendar|cron|web_search)\b/g))
          bad.push(`${c.id}: ${m[1]}`);
      }
    expect(bad).toEqual([]);
  });
});
