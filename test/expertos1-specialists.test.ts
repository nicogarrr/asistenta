import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Subagentes especialistas (asis-expertos-1, PR 1): registro, delegate(specialist),
 * lista blanca por herramienta y por accion, y Gate propia del especialista.
 * Solo dobles en memoria: sin modelo, sin red.
 */
const stateDir = mkdtempSync(join(tmpdir(), 'pa-expertos1-'));
process.env.PA_STATE_DIR = stateDir;
vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logHost: vi.fn(),
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const { resolveSpecialist, specialistNames, specialistToolNames, SPECIALISTS } = await import(
  '../src/core/specialists.js'
);
const { createSubagentDeps, isolateSpecialistTools } = await import(
  '../src/core/subagent-runner.js'
);
const { SubagentPool, SUBAGENT_DEFAULT_LIMITS } = await import('../src/core/subagent.js');
const { createDelegateTool } = await import('../src/tools/delegate.js');
const { createChildGate } = await import('../src/core/subagent-wiring.js');
type ChildSpec = import('../src/core/subagent-runner.js').ChildSpec;
type SpecialistSpec = import('../src/core/specialists.js').SpecialistSpec;

afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const ran: Array<{ name: string; args: unknown }> = [];
function tool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    execute: async (_id: string, args: unknown) => {
      ran.push({ name, args });
      return { content: [{ type: 'text', text: `ok-${name}` }], details: {} };
    },
  } as unknown as AgentTool;
}

const PARENT = [
  'read',
  'list',
  'fetch',
  'web',
  'write',
  'shell',
  'browser',
  'computer',
  'correo',
].map(tool);

let specs: ChildSpec[];
function setup() {
  specs = [];
  const deps = createSubagentDeps({
    parentTools: () => PARENT,
    makeChild: async (spec) => {
      specs.push(spec);
      return { run: async () => ({ text: 'hecho', toolCalls: 0 }), abort: () => {} };
    },
  });
  const pool = new SubagentPool(deps, { timeoutMs: 5_000 });
  return createDelegateTool(pool, () => 0);
}

async function delegate(args: Record<string, unknown>) {
  const t = setup();
  const res = await t.execute('d1', args as never);
  return { text: (res.content[0] as { text: string }).text, details: res.details };
}

beforeEach(() => {
  ran.length = 0;
});

describe('registro de especialistas', () => {
  it('resuelve por nombre, mayusculas, tildes y alias; lo desconocido es undefined', () => {
    expect(resolveSpecialist('web')?.name).toBe('web');
    expect(resolveSpecialist('  WEB ')?.name).toBe('web');
    expect(resolveSpecialist('Internet')?.name).toBe('web');
    expect(resolveSpecialist('búsqueda')?.name).toBe('web');
    for (const bad of ['astrologo', '', '__proto__', 'constructor', 'toString', 42, null]) {
      expect(resolveSpecialist(bad)).toBeUndefined();
    }
  });

  it('cada especialista tiene prompt corto en castellano, sin secretos, y lista blanca', () => {
    expect(specialistNames()).toContain('web');
    for (const name of specialistNames()) {
      const s = SPECIALISTS[name] as SpecialistSpec;
      expect(s.name).toBe(name);
      expect(s.prompt.length).toBeGreaterThan(40);
      expect(s.prompt.length).toBeLessThanOrEqual(700);
      expect(s.prompt).toMatch(/Eres el especialista/);
      expect(s.prompt).not.toMatch(/PA_|token|apikey|api key|password|contraseña/i);
      expect(s.tools.length).toBeGreaterThan(0);
      for (const banned of ['delegate', 'preguntar', 'ask', 'shell', 'write']) {
        expect(s.tools).not.toContain(banned);
      }
      expect(Object.isFrozen(s)).toBe(true);
      expect(Object.isFrozen(s.tools)).toBe(true);
    }
  });

  it('tools del caller solo estrechan la lista del especialista, nunca la amplian', () => {
    const web = resolveSpecialist('web') as SpecialistSpec;
    expect(specialistToolNames(web, ['web', 'shell', 'write', 'web'])).toEqual(['web']);
    expect(specialistToolNames(web, [])).toEqual([]);
    expect(specialistToolNames(web)).toEqual([...web.tools]);
  });

  it('los limites del pool no cambian', () => {
    expect({ ...SUBAGENT_DEFAULT_LIMITS }).toEqual({
      maxDepth: 2,
      maxConcurrent: 2,
      maxToolCalls: 25,
    });
  });
});

describe('delegate(specialist)', () => {
  it('web: el hijo recibe el prompt del especialista y solo sus herramientas', async () => {
    const r = await delegate({ task: 'compara el precio del AirPods Pro', specialist: 'web' });
    expect(r.text).toBe('hecho');
    expect(r.details).toMatchObject({ specialist: 'web' });
    expect(specs).toHaveLength(1);
    const spec = specs[0] as ChildSpec;
    expect(spec.specialist?.name).toBe('web');
    expect(spec.prompt).toContain('Eres el especialista web');
    expect(spec.prompt).toContain('Tarea: compara el precio del AirPods Pro');
    expect(spec.prompt).not.toContain('Rol EXPLORER');
    expect(spec.toolset.map((t) => t.name).sort()).toEqual(['fetch', 'list', 'read', 'web']);
  });

  it('web con tools que piden write/shell/correo: se quedan fuera', async () => {
    await delegate({
      task: 'busca',
      specialist: 'web',
      tools: ['web', 'write', 'shell', 'correo'],
    });
    expect((specs[0] as ChildSpec).toolset.map((t) => t.name)).toEqual(['web']);
  });

  it('especialista desconocido: hijo generico de siempre y se avisa en details', async () => {
    const r = await delegate({ task: 'mira esto', specialist: 'astrologo' });
    expect(r.text).toMatch(/^Aviso: no existe el especialista «astrologo»/);
    expect(r.text.endsWith('\n\nhecho')).toBe(true);
    expect(r.details).toMatchObject({ unknownSpecialist: 'astrologo' });
    expect(r.details).not.toHaveProperty('specialist');
    const spec = specs[0] as ChildSpec;
    expect(spec.specialist).toBeUndefined();
    expect(spec.prompt).toContain('Rol EXPLORER');
    expect(spec.toolset.map((t) => t.name).sort()).toEqual(['fetch', 'list', 'read', 'web']);
  });

  it('sin specialist todo sigue igual que antes (rol planner)', async () => {
    const r = await delegate({ task: 'planifica', role: 'planner' });
    expect(r.details).toEqual({ depth: 1 });
    expect((specs[0] as ChildSpec).prompt).toContain('Rol PLANNER');
    expect((specs[0] as ChildSpec).toolset.map((t) => t.name).sort()).toEqual(['list', 'read']);
  });

  it('la descripcion de delegate nombra los especialistas y el parametro existe', () => {
    const t = setup();
    expect(t.description).toContain('Especialistas: web');
    const props = (t.parameters as { properties: Record<string, unknown> }).properties;
    expect(props).toHaveProperty('specialist');
  });
});

describe('lista blanca por accion', () => {
  const lector: SpecialistSpec = Object.freeze({
    name: 'lector',
    title: 'Lector',
    prompt: 'Eres el especialista lector de pruebas.',
    tools: Object.freeze(['correo', 'read']),
    actions: Object.freeze({ correo: Object.freeze(['buscar', 'leer']) }),
    effectful: false,
    examples: Object.freeze([]),
  });

  it('una accion fuera de la lista no se ejecuta; una permitida si', async () => {
    const ctrl = new AbortController();
    const set = isolateSpecialistTools(PARENT, lector, ['correo', 'read', 'shell'], ctrl.signal, 5);
    expect(set.map((t) => t.name).sort()).toEqual(['correo', 'read']);
    const correo = set.find((t) => t.name === 'correo') as AgentTool;
    for (const action of ['nuevo', 'responder', 'reenviar', undefined]) {
      await expect(correo.execute('x', { action } as never)).rejects.toThrow(/Lector/);
    }
    await correo.execute('y', { action: 'buscar', query: 'factura' } as never);
    const read = set.find((t) => t.name === 'read') as AgentTool;
    await read.execute('z', { path: 'a.md' } as never);
    expect(ran.map((r) => r.name)).toEqual(['correo', 'read']);
  });

  it('Gate del especialista: solo sus pares herramienta:accion; envio, shell y write fuera', async () => {
    const gate = createChildGate({}, lector);
    const v = async (tool: string, args: Record<string, unknown>) =>
      (await gate.check('s', { tool, args, actor: 'subagent' })).verdict;
    expect(await v('correo', { action: 'buscar', query: 'x' })).toBe('allow');
    expect(await v('correo', { action: 'nuevo', to: 'a@b.c' })).toBe('deny');
    expect(await v('shell', { command: 'ls' })).toBe('deny');
    expect(await v('write', { path: 'x', content: 'y' })).toBe('deny');
    expect(await v('computer', { action: 'click' })).toBe('deny');
  });

  it('Gate del especialista web: lectura permitida, nada con efectos', async () => {
    const gate = createChildGate({}, resolveSpecialist('web'));
    const v = async (tool: string, args: Record<string, unknown>) =>
      (await gate.check('s', { tool, args, actor: 'subagent' })).verdict;
    expect(await v('read', { path: 'notas.md' })).toBe('allow');
    for (const t of ['shell', 'write', 'browser', 'computer', 'tv', 'delegate', 'preguntar']) {
      expect(await v(t, { action: 'x' })).toBe('deny');
    }
  });
});
