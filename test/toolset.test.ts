import type { AgentTool } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { ToolLoadout } from '../src/core/toolset.js';

const tool = (name: string) =>
  ({
    name,
    label: name,
    description: name,
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
  }) as unknown as AgentTool;
const all = ['read', 'fetch', 'browser', 'media', 'memory'].map(tool);
const names = (l: ToolLoadout) => l.active().map((t) => t.name);

describe('ToolLoadout', () => {
  it('starts without browser and media, with the loader', () => {
    expect(names(new ToolLoadout(all))).toEqual(['read', 'fetch', 'memory', 'cargar_herramienta']);
  });

  it('loads the browser when the message names a site, and keeps it', () => {
    const l = new ToolLoadout(all);
    expect(l.loadFor('mira los trenes en renfe.com a Barcelona')).toEqual(['browser']);
    expect(names(l)).toContain('browser');
    expect(l.loadFor('gracias')).toEqual([]);
    expect(names(l)).toContain('browser');
  });

  it('does not load anything for plain chat', () => {
    const l = new ToolLoadout(all);
    expect(l.loadFor('¿qué tengo hoy en el calendario?')).toEqual([]);
    expect(names(l)).not.toContain('media');
  });

  it('the loader tool loads by name and bumps the version', async () => {
    const l = new ToolLoadout(all);
    const v = l.version;
    const loader = l.active().find((t) => t.name === 'cargar_herramienta') as AgentTool;
    const r = await loader.execute('1', { nombre: 'media' } as never);
    expect(JSON.stringify(r.content)).toContain('cargada');
    expect(l.version).toBe(v + 1);
    expect(names(l)).toContain('media');
  });

  it('rejects unknown names and lists the available ones', async () => {
    const l = new ToolLoadout(all);
    const loader = l.active().find((t) => t.name === 'cargar_herramienta') as AgentTool;
    const r = await loader.execute('1', { nombre: 'shell' } as never);
    expect(JSON.stringify(r.content)).toContain('No existe');
    expect(JSON.stringify(r.content)).toContain('browser');
  });

  it('drops the loader once everything is loaded', () => {
    const l = new ToolLoadout(all);
    l.load('browser');
    l.load('media');
    expect(names(l)).not.toContain('cargar_herramienta');
  });
});
