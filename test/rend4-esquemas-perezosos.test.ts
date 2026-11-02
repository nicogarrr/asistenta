import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as typebox from 'typebox';
import { describe, expect, it } from 'vitest';
import { lazySchema, Type } from '../src/core/lazy-schema.js';
import { fsTools } from '../src/tools/fs.js';
import { createWeatherTool } from '../src/tools/weather.js';

/**
 * typebox (~370 módulos ESM, ~45 ms) ya no se carga al arrancar `pa`: los esquemas de
 * las herramientas se construyen al primer uso (src/core/lazy-schema.ts) y luego son
 * siempre el mismo objeto, como la constante de módulo de antes.
 */
function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return tsFiles(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

/** Dependencias de mentira: cualquier propiedad o llamada devuelve otra igual. */
const dummy: unknown = new Proxy(() => {}, {
  get: (_t, key) => (key === 'then' ? undefined : key === Symbol.toPrimitive ? () => '' : dummy),
  apply: () => dummy,
  construct: () => dummy as object,
});

type ToolLike = { name: string; parameters: unknown };
const isTool = (v: unknown): v is ToolLike =>
  !!v && typeof v === 'object' && typeof (v as ToolLike).name === 'string' && 'parameters' in v;

async function buildAll(): Promise<Map<string, ToolLike>> {
  const out = new Map<string, ToolLike>();
  for (const dir of ['src/tools', 'src/plugins']) {
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const mod = (await import(pathToFileURL(resolve(dir, file)).href)) as Record<string, unknown>;
      for (const [name, value] of Object.entries(mod)) {
        let built: unknown;
        if (typeof value === 'function' && /^create\w*Tools?$/.test(name)) {
          try {
            built = value(dummy, dummy, dummy);
          } catch {
            built = value(
              new Proxy({ maxAmountCents: 30_000, loadPassenger: undefined } as object, {
                get: (t, k) => (k in t ? (t as Record<PropertyKey, unknown>)[k] : dummy),
              }),
            );
          }
        } else if (Array.isArray(value)) built = value;
        else if (value && typeof value === 'object' && 'tools' in value) {
          built = (value as { tools: (d: unknown) => unknown }).tools(dummy);
        } else built = value;
        for (const tool of Array.isArray(built) ? built : [built]) {
          if (isTool(tool)) out.set(`${dir}/${file}#${name}:${tool.name}`, tool);
        }
      }
    }
  }
  return out;
}

describe('esquemas de herramientas perezosos', () => {
  it('ningún fichero de src importa typebox como valor salvo core/lazy-schema.ts', () => {
    const offenders = tsFiles('src').filter((file) => {
      if (file.replaceAll('\\', '/').endsWith('src/core/lazy-schema.ts')) return false;
      const text = readFileSync(file, 'utf8');
      return (
        /^\s*import\s+(?!type\b)[^;]*from\s+['"]typebox(?:\/[^'"]*)?['"]/m.test(text) ||
        /import\(\s*['"]typebox/.test(text)
      );
    });
    expect(offenders).toEqual([]);
  });

  it('`pa ayuda` no carga typebox', () => {
    const hook = `data:text/javascript,${encodeURIComponent(
      "import{registerHooks}from'node:module';registerHooks({resolve(s,c,n){if(s==='typebox'||s.startsWith('typebox/'))process.stderr.write('TYPEBOX_CARGADO\\n');return n(s,c)}});",
    )}`;
    const { FORCE_COLOR: _force, ...envWithoutColor } = process.env;
    const res = spawnSync(process.execPath, ['--import', hook, resolve('dist/cli.js'), 'ayuda'], {
      encoding: 'utf8',
      env: { ...envWithoutColor, NO_COLOR: '1' },
      timeout: 60_000,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Asistenta');
    expect(res.stderr).not.toContain('TYPEBOX_CARGADO');
  });

  it('Type es el de typebox y lazySchema memoriza el mismo objeto', () => {
    expect(Type.Object).toBe(typebox.Type.Object);
    let builds = 0;
    const schema = lazySchema(() => {
      builds++;
      return Type.Object({ a: Type.String() });
    });
    expect(builds).toBe(0);
    const first = schema();
    expect(schema()).toBe(first);
    expect(builds).toBe(1);
    expect(first).toEqual(typebox.Type.Object({ a: typebox.Type.String() }));
  });

  it('cada herramienta da un esquema typebox real y siempre el mismo objeto', async () => {
    const first = await buildAll();
    const second = await buildAll();
    expect(first.size).toBeGreaterThan(45);
    for (const [key, tool] of first) {
      const params = tool.parameters as Record<string, unknown>;
      expect(typebox.Type.IsSchema(params), key).toBe(true);
      expect(params.type, key).toBe('object');
      expect(second.get(key)?.parameters, key).toBe(params);
    }
  });

  it('read/write/list y tiempo: mismo esquema que construido a mano con typebox', () => {
    const T = typebox.Type;
    const [read, write, list] = fsTools;
    expect(read.parameters).toEqual(
      T.Object({
        path: T.String({
          description: 'File path, absolute or relative to the working directory.',
        }),
        offset: T.Optional(T.Number({ description: 'First line to return, 1-based. Default 1.' })),
        limit: T.Optional(
          T.Number({ description: 'How many lines to return. Default: everything left.' }),
        ),
      }),
    );
    expect(write.parameters).toEqual(
      T.Object({
        path: T.String({ description: 'File path.' }),
        content: T.String({ description: 'Full file contents.' }),
      }),
    );
    expect(list.parameters).toEqual(
      T.Object({
        path: T.Optional(
          T.String({ description: 'Directory path. Defaults to the working directory.' }),
        ),
      }),
    );
    expect({ ...read }.parameters).toBe(read.parameters);
    expect(createWeatherTool(() => null).parameters).toEqual(
      T.Object({
        dias: T.Optional(
          T.Integer({ minimum: 1, maximum: 7, description: 'Días de previsión desde hoy (1-7).' }),
        ),
      }),
    );
  });
});
