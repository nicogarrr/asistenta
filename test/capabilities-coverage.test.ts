import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '../src/core/capabilities.js';

// Cada herramienta que el daemon construye para un hilo (threadTools en src/cli.ts) tiene
// que tener entrada en el catálogo (src/core/capabilities.ts) o estar aquí exenta a
// propósito, con el motivo. Así una herramienta nueva no puede aparecer sin que alguien
// decida si mueve la máquina, si es solo de escritorio, si va libre en hilos o si es diferida.
// Exentas = herramientas sin metadatos: sin mutex, en todos los modos, la Gate decide, siempre cargadas.
const EXEMPT: Record<string, string> = {
  calendar: 'calendario de Google: llamada de red; la Gate pregunta las escrituras',
  decision: 'registro de decisiones en SQLite propio; no toca la máquina',
  documents: 'índice de documentos (docs.sqlite); solo lectura/índice',
  download: 'descarga a la carpeta de descargas; la Gate pregunta por acción',
  fabrica: 'crea skills/herramientas propuestas; la Gate y el guard de selfimprove deciden',
  servicio: 'publica servicios en la tailnet; la Gate pregunta por acción',
  skills: 'lee y guarda skills procedimentales del modelo',
  vigilar_precio: 'alta/baja de vigilancias de precio; mismas lecturas sin modelo que /vigila',
  web: 'búsqueda web (red); sin estado de la máquina',
};

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const files = walk(SRC).map((p) => ({ p, t: readFileSync(p, 'utf8') }));
const consts = new Map<string, string>();
for (const { t } of files) {
  for (const m of t.matchAll(/export const ([A-Z_]+)\s*=\s*'([a-z_0-9]+)'/g))
    consts.set(m[1], m[2]);
}

/** Nombres de herramienta (name: 'x' o name: CONSTANTE) definidos en un texto. */
function toolNamesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\bname:\s*(?:'([a-z_0-9]+)'|([A-Z_]+)\b)/g)) {
    const n = m[1] ?? consts.get(m[2]);
    if (n) out.push(n);
  }
  return out;
}

/** Cuerpo de `const threadTools = (thread: Thread) => { ... }` en cli.ts. */
function threadToolsBlock(): string {
  const cli = readFileSync(join(SRC, 'cli.ts'), 'utf8');
  const start = cli.indexOf('const threadTools = (thread: Thread)');
  expect(start, 'threadTools no encontrado en src/cli.ts').toBeGreaterThan(-1);
  const open = cli.indexOf('{', cli.indexOf('=>', start));
  let depth = 0;
  for (let i = open; i < cli.length; i++) {
    if (cli[i] === '{') depth++;
    else if (cli[i] === '}' && --depth === 0) return cli.slice(open, i);
  }
  throw new Error('threadTools sin cerrar');
}

function builtToolNames(): Map<string, string> {
  const byName = new Map<string, string>();
  const factories = new Set(
    [...threadToolsBlock().matchAll(/\b(create\w*Tools?)\(/g)].map((m) => m[1]),
  );
  for (const fac of factories) {
    const def = files.find(({ t }) => new RegExp(`export (async )?function ${fac}\\b`).test(t));
    if (!def) continue; // fábricas de stores/páginas, no herramientas
    for (const n of toolNamesIn(def.t)) byName.set(n, fac);
  }
  return byName;
}

describe('catálogo de capacidades ↔ herramientas que construye el daemon', () => {
  const built = builtToolNames();
  const catalog = new Set(CAPABILITIES.map((c) => c.name));

  it('encuentra las herramientas de threadTools (el escaneo sigue vivo)', () => {
    for (const n of ['computer', 'browser', 'memory', 'tv', 'checkout'])
      expect(built.has(n), n).toBe(true);
    expect(built.size).toBeGreaterThan(20);
  });

  it('toda herramienta construida tiene entrada en el catálogo o exención explícita', () => {
    const missing = [...built.keys()].filter((n) => !catalog.has(n) && !(n in EXEMPT));
    expect(
      missing,
      'añade una entrada a src/core/capabilities.ts o una exención con motivo aquí',
    ).toEqual([]);
  });

  it('ninguna herramienta está a la vez en el catálogo y exenta', () => {
    expect(Object.keys(EXEMPT).filter((n) => catalog.has(n))).toEqual([]);
  });

  it('no hay exenciones caducadas (cada exenta se sigue construyendo)', () => {
    expect(Object.keys(EXEMPT).filter((n) => !built.has(n))).toEqual([]);
  });

  it('cada entrada del catálogo nombra una herramienta que existe en src/', () => {
    const defined = new Set(
      files.filter(({ p }) => !p.endsWith('capabilities.ts')).flatMap(({ t }) => toolNamesIn(t)),
    );
    expect(CAPABILITIES.map((c) => c.name).filter((n) => !defined.has(n))).toEqual([]);
  });
});
