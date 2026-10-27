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
