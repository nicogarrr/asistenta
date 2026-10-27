import type { AgentTool } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { SubagentPool } from '../src/core/subagent.js';
import {
  type ChildSpec,
  createSubagentDeps,
  isolateTools,
  resolveChildToolNames,
  SUBAGENT_SAFE_TOOLS,
} from '../src/core/subagent-runner.js';
import { createDelegateTool } from '../src/tools/delegate.js';

const fakeTool = (name: string, log: string[] = []): AgentTool =>
  ({
    name,
    label: name,
    description: name,
    parameters: {},
    execute: async () => {
      log.push(name);
      return { content: [{ type: 'text', text: name }], details: {} };
    },
  }) as unknown as AgentTool;

describe('resolveChildToolNames', () => {
  it('descarta herramientas con efectos aunque se pidan', () => {
    const r = resolveChildToolNames('explorer', ['read', 'write', 'shell', 'browser', 'fetch']);
    expect(r.allowed).toEqual(['read', 'fetch']);
    expect(r.dropped).toEqual(['write', 'shell', 'browser']);
  });
  it('sin peticion usa las del rol; planner e implementer no tienen red', () => {
    expect(resolveChildToolNames('planner').allowed).toEqual(['read', 'list']);
    expect(resolveChildToolNames('implementer', ['web', 'read']).allowed).toEqual(['read']);
  });
  it('la lista segura es solo lectura', () => {
    expect(SUBAGENT_SAFE_TOOLS).toEqual(['read', 'list', 'fetch', 'web']);
  });
});

describe('isolateTools', () => {
  it('el hijo solo ve las permitidas y no puede ejecutar tras abortar', async () => {
    const log: string[] = [];
    const ac = new AbortController();
    const tools = ['read', 'write', 'shell', 'list'].map((n) => fakeTool(n, log));
    const iso = isolateTools(tools, ['read', 'write', 'list'], ac.signal);
    expect(iso.map((t) => t.name)).toEqual(['read', 'list']);
    await iso[0]?.execute('id', {} as never, undefined, undefined);
    expect(log).toEqual(['read']);
    ac.abort();
    await expect(iso[0]?.execute('id', {} as never, undefined, undefined)).rejects.toThrow(
      /abortado/,
    );
    expect(log).toEqual(['read']);
  });
});

describe('createSubagentDeps via pool y delegate', () => {
  function setup() {
    const specs: ChildSpec[] = [];
    const prompts: string[] = [];
    let created = 0;
    const deps = createSubagentDeps({
      parentTools: () => [],
      makeChild: async (spec) => {
        specs.push(spec);
        created++;
        return {
          run: async (p) => {
            prompts.push(p);
            return { text: `ok-${created}`, toolCalls: 1 };
          },
          abort: () => {},
        };
      },
    });
    return { specs, prompts, deps, created: () => created };
  }

  it('crea un hijo nuevo por tarea, sin transcript del padre, y filtra tools', async () => {
    const { specs, prompts, deps, created } = setup();
    const pool = new SubagentPool(deps);
    const a = await pool.run({ task: 'A', role: 'planner', tools: ['read', 'shell'] });
    const b = await pool.run({ task: 'B', role: 'explorer' });
    expect(a.text).toBe('ok-1');
    expect(b.text).toBe('ok-2');
    expect(created()).toBe(2);
    expect(specs[0]?.tools).toEqual(['read']);
    expect(specs[1]?.tools).toEqual(['read', 'list', 'fetch', 'web']);
    expect(prompts[0]).toContain('PLANNER');
    expect(prompts[0]).not.toContain('Tarea: B');
  });

  it('rol desconocido falla cerrado sin crear hijo', async () => {
    const { deps, created } = setup();
    const pool = new SubagentPool(deps);
    const r = await pool.run({ task: 'x', role: 'root' });
    expect(r.error).toMatch(/Rol de subagente desconocido/);
    expect(created()).toBe(0);
  });

  it('el aborto por timeout llega al hijo', async () => {
    let aborted = false;
    const deps = createSubagentDeps({
      parentTools: () => [],
      makeChild: async () => ({
        run: () => new Promise(() => {}),
        abort: () => {
          aborted = true;
        },
      }),
    });
    const pool = new SubagentPool(deps, { timeoutMs: 20 });
    const r = await pool.run({ task: 'cuelga', role: 'explorer' });
    expect(r.error).toMatch(/timeout/i);
    expect(aborted).toBe(true);
  });

  it('delegate pasa el rol al pool', async () => {
    const { specs, deps } = setup();
    const tool = createDelegateTool(new SubagentPool(deps), () => 0);
    const res = await tool.execute('1', { task: 'plan', role: 'implementer' } as never);
    expect(res.details.error).toBeUndefined();
    expect(specs[0]?.role).toBe('implementer');
    expect(specs[0]?.tools).toEqual(['read', 'list']);
  });
});

describe('auditoria #288', () => {
  it('lista vacia explicita significa ninguna herramienta (no se amplia al rol)', async () => {
    expect(resolveChildToolNames('explorer', []).allowed).toEqual([]);
    expect(resolveChildToolNames('explorer', undefined).allowed).toEqual([
      'read',
      'list',
      'fetch',
      'web',
    ]);
    const specs: ChildSpec[] = [];
    const deps = createSubagentDeps({
      parentTools: () => ['read', 'list', 'fetch', 'web'].map((n) => fakeTool(n)),
      makeChild: async (spec) => {
        specs.push(spec);
        return { run: async () => ({ text: 'ok' }), abort: () => {} };
      },
    });
    const pool = new SubagentPool(deps);
    await pool.run({ task: 'a', role: 'explorer', tools: [] });
    await pool.run({ task: 'b', role: 'explorer' });
    expect(specs[0]?.tools).toEqual([]);
    expect(specs[0]?.toolset).toEqual([]);
    expect(specs[1]?.toolset.map((t) => t.name)).toEqual(['read', 'list', 'fetch', 'web']);
  });

  it('senal ya abortada: el hijo no llega a ejecutar (ran=0)', async () => {
    let ran = 0;
    let made = 0;
    const deps = createSubagentDeps({
      parentTools: () => [],
      makeChild: async () => {
        made++;
        return {
          run: async () => {
            ran++;
            return { text: 'no' };
          },
          abort: () => {},
        };
      },
    });
    const ac = new AbortController();
    ac.abort();
    const r = await deps.run({
      task: 'x',
      role: 'explorer',
      depth: 1,
      budget: { maxToolCalls: 3, tools: [], signal: ac.signal },
    });
    expect(ran).toBe(0);
    expect(made).toBe(0);
    expect(r.error).toMatch(/abortado/);
  });

  it('fabrica lenta que acaba tras el timeout: se aborta y no se ejecuta', async () => {
    let ran = 0;
    let aborted = 0;
    const deps = createSubagentDeps({
      parentTools: () => [],
      makeChild: async () => {
        await new Promise((r) => setTimeout(r, 80));
        return {
          run: async () => {
            ran++;
            return { text: 'no' };
          },
          abort: () => {
            aborted++;
          },
        };
      },
    });
    const pool = new SubagentPool(deps, { timeoutMs: 20 });
    const r = await pool.run({ task: 'lenta', role: 'explorer' });
    expect(r.error).toMatch(/timeout/i);
    await new Promise((res) => setTimeout(res, 150));
    expect(ran).toBe(0);
    expect(aborted).toBe(1);
  });

  it('el toolset del hijo se aisla por construccion y respeta maxToolCalls', async () => {
    const log: string[] = [];
    let names: string[] = [];
    let third = '';
    const deps = createSubagentDeps({
      parentTools: () => ['read', 'write', 'shell', 'list'].map((n) => fakeTool(n, log)),
      makeChild: async (sp) => ({
        run: async () => {
          names = sp.toolset.map((t) => t.name);
          const read = sp.toolset[0];
          await read?.execute('1', {} as never, undefined, undefined);
          await read?.execute('2', {} as never, undefined, undefined);
          try {
            await read?.execute('3', {} as never, undefined, undefined);
          } catch (e) {
            third = String(e);
          }
          return { text: 'ok' };
        },
        abort: () => {},
      }),
    });
    await new SubagentPool(deps, { maxToolCalls: 2 }).run({
      task: 't',
      role: 'explorer',
      tools: ['read', 'write', 'shell'],
    });
    expect(names).toEqual(['read']);
    expect(third).toMatch(/agotado/);
    expect(log).toEqual(['read', 'read']);
  });
});
