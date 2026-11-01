/**
 * Auto-chequeo de habilidades (estilo Voyager): una habilidad nueva solo se da
 * por lista si se puede seguir hoy en este PC.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkSkill } from '../src/skills/selfcheck.js';
import { SkillStore } from '../src/skills/store.js';
import { createSkillsTool } from '../src/tools/skills.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

let dir = '';
let store: SkillStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-selfcheck-'));
  store = new SkillStore({ dir });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const base = {
  name: 'Cumpleaños',
  description: 'Recuerda cumpleaños y prepara la felicitación',
  category: 'personal',
  whenToUse: 'cuando se acerca un cumpleaños',
  steps: ['mirar el calendario de la semana', 'avisar con un borrador de felicitación'],
};

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((part) => part.text ?? '').join('\n');
}

describe('auto-chequeo de habilidades', () => {
  it('lista cuando tiene lo que necesita; avisa de que pedirá permiso', () => {
    const id = store.save({ ...base, outward: true, needs: ['calendario'] });
    const skill = store.read(id);
    if (!skill) throw new Error('no guardada');
    const res = checkSkill(skill, { capabilities: new Set(['calendario']), toolNames: [] });
    expect(res.ready).toBe(true);
    expect(res.summary).toContain('te pediré permiso');
  });

  it('dice qué falta configurar', () => {
    const id = store.save({ ...base, needs: ['calendario', 'contactos'] });
    const skill = store.read(id);
    if (!skill) throw new Error('no guardada');
    const res = checkSkill(skill, { capabilities: new Set(['calendario']) });
    expect(res.ready).toBe(false);
    expect(res.summary).toContain('falta configurar contactos');
  });

  it('sin forma de comprobar no dice «lista»', () => {
    const id = store.save({ ...base, needs: ['correo'], tool: 'fab_facturas' });
    const skill = store.read(id);
    if (!skill) throw new Error('no guardada');
    const res = checkSkill(skill);
    expect(res.ready).toBe(false);
    expect(res.unchecked).toEqual(['correo', 'la herramienta fab_facturas']);
    expect(res.summary).toContain('Sin comprobar');
  });

  it('una herramienta de la fábrica no instalada la deja sin funcionar', () => {
    const id = store.save({ ...base, tool: 'fab_felicitar' });
    const skill = store.read(id);
    if (!skill) throw new Error('no guardada');
    const res = checkSkill(skill, { toolNames: ['skills', 'memory'] });
    expect(res.problems[0]).toContain('no está instalada');
    expect(checkSkill(skill, { toolNames: ['fab_felicitar'] }).ready).toBe(true);
  });

  it('una desactivada nunca está lista', () => {
    const id = store.save(base);
    store.setDisabled(id, true);
    const skill = store.read(id);
    if (!skill) throw new Error('no guardada');
    expect(checkSkill(skill, { capabilities: new Set(), toolNames: [] }).ready).toBe(false);
  });

  it('la herramienta skills hace el chequeo con lo que hay en el PC', async () => {
    const tool = createSkillsTool({
      store,
      checkEnv: () => ({ capabilities: new Set(['correo']), toolNames: ['skills'] }),
    });
    const id = store.save({ ...base, needs: ['calendario'] });
    const res = await tool.execute('c1', { action: 'check', id }, undefined, undefined);
    expect(text(res)).toContain('falta configurar calendario');
    const none = await tool.execute('c2', { action: 'check', id: 'nada' }, undefined, undefined);
    expect(text(none)).toContain('No tengo ninguna habilidad');
  });
});
