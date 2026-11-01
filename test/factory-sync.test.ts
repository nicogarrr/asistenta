import type { AgentTool } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { createFactorySync } from '../src/factory/loader.js';

function tool(name: string, description: string, props: Record<string, unknown> = {}): AgentTool {
  return {
    name,
    label: name,
    description,
    parameters: { type: 'object', properties: props },
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
  } as unknown as AgentTool;
}

function harness() {
  let installed: AgentTool[] = [];
  const live = new Map<string, AgentTool>();
  const log: string[] = [];
  const sync = createFactorySync(
    (t) => {
      log.push(`+${t.name}`);
      live.set(t.name, t);
    },
    (n) => {
      log.push(`-${n}`);
      live.delete(n);
    },
    async () => installed,
  );
  return {
    sync,
    live,
    log,
    set: (ts: AgentTool[]) => {
      installed = ts;
    },
  };
}

describe('createFactorySync', () => {
  it('registra altas y retira bajas, idempotente', async () => {
    const h = harness();
    h.set([tool('fab_a', 'A')]);
    await h.sync();
    await h.sync();
    expect(h.log).toEqual(['+fab_a']);
    h.set([]);
    await h.sync();
    await h.sync();
    expect(h.log).toEqual(['+fab_a', '-fab_a']);
    expect(h.live.size).toBe(0);
  });

  it('una reinstalación con el mismo nombre y otra descripción sustituye la herramienta viva', async () => {
    const h = harness();
    h.set([tool('fab_eco', 'Devuelve el texto')]);
    await h.sync();
    h.set([tool('fab_eco', 'Devuelve el texto en mayúsculas')]);
    await h.sync();
    expect(h.live.get('fab_eco')?.description).toBe('Devuelve el texto en mayúsculas');
    expect(h.log).toEqual(['+fab_eco', '-fab_eco', '+fab_eco']);
  });

  it('una reinstalación con otros parámetros también la sustituye', async () => {
    const h = harness();
    h.set([tool('fab_eco', 'Eco', { msg: { type: 'string' } })]);
    await h.sync();
    h.set([tool('fab_eco', 'Eco', { msg: { type: 'string' }, veces: { type: 'number' } })]);
    await h.sync();
    const params = h.live.get('fab_eco')?.parameters as { properties: Record<string, unknown> };
    expect(Object.keys(params.properties)).toEqual(['msg', 'veces']);
  });

  it('sin cambios no vuelve a registrar aunque el cargador devuelva objetos nuevos', async () => {
    const h = harness();
    h.set([tool('fab_eco', 'Eco')]);
    await h.sync();
    h.set([tool('fab_eco', 'Eco')]);
    await h.sync();
    expect(h.log).toEqual(['+fab_eco']);
  });
});
