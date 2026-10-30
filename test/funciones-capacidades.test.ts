import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAPABILITIES, threadAllowToolNames } from '../src/core/capabilities.js';
import { areaAbilities, FUNCION_AREAS, funcionesText, TOOL_ABILITIES } from '../src/funciones.js';

/** Nombres de herramienta que ve el modelo, leídos del código de src/tools. */
function toolNamesInSource(): Set<string> {
  const dir = join(__dirname, '..', 'src', 'tools');
  const names = new Set<string>(CAPABILITIES.map((c) => c.name));
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(join(dir, file), 'utf8');
    for (const m of src.matchAll(/NAME = '([a-z_]+)'/g)) names.add(m[1] as string);
    for (const m of src.matchAll(/^ {2,6}name: '([a-z_]+)',/gm)) names.add(m[1] as string);
  }
  return names;
}

describe('/funciones: lo que sé hacer sin comando', () => {
  it('cada herramienta real tiene su línea (o está marcada como interna), y ninguna sobra', () => {
    const real = toolNamesInSource();
    expect(real.size).toBeGreaterThan(20);
    expect([...real].filter((n) => !(n in TOOL_ABILITIES)).sort()).toEqual([]);
    expect(
      Object.keys(TOOL_ABILITIES)
        .filter((n) => !real.has(n))
        .sort(),
    ).toEqual([]);
  });

  it('cada línea va a un área que existe y está en español llano (sin nombres de herramienta)', () => {
    const ids = new Set(FUNCION_AREAS.map((a) => a.id));
    for (const [tool, a] of Object.entries(TOOL_ABILITIES)) {
      if (!a) continue;
      expect(ids.has(a.area), tool).toBe(true);
      expect(a.text.length, tool).toBeLessThan(90);
      expect(a.text, tool).not.toMatch(/[_]|\baction=|\btool\b/);
    }
  });

  it('el área de la tele dice en palabras llanas lo que hace, además de los comandos', () => {
    const text = funcionesText({ owner: true }, 'tele');
    expect(text).toContain('Pídemelo con tus palabras:');
    expect(text).toContain('abro apps de la tele');
    expect(text).toContain('/tv');
  });

  it('el PC enseña ratón y teclado al dueño', () => {
    expect(funcionesText({ owner: true }, 'pc')).toContain('uso el ratón y el teclado');
  });

  it('fuera del chat del dueño solo salen herramientas que funcionan sin aprobación', () => {
    const open = new Set(threadAllowToolNames());
    for (const area of FUNCION_AREAS) {
      for (const line of areaAbilities({ owner: false }, area.id)) {
        const tools = Object.entries(TOOL_ABILITIES)
          .filter(([, a]) => a?.text === line)
          .map(([t]) => t);
        expect(
          tools.some((t) => open.has(t)),
          line,
        ).toBe(true);
      }
    }
    expect(areaAbilities({ owner: false }, 'pc')).not.toContain(
      'uso el ratón y el teclado de tu PC por ti, con tu permiso',
    );
    expect(areaAbilities({ owner: false }, 'agenda')).toContain(
      'te recuerdo cosas a la hora que digas',
    );
  });

  it('un área sin línea propia no lleva el bloque', () => {
    expect(areaAbilities({ owner: true }, 'modelo')).toEqual([]);
    expect(funcionesText({ owner: true }, 'modelo')).not.toContain('Pídemelo con tus palabras');
  });
});
