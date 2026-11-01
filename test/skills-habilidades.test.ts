/**
 * Habilidades desde el chat: «¿qué habilidades tienes?», «quita la de X»,
 * «vuelve a ponerla», «bórrala». Y lo creado desde el chat pide permiso por
 * defecto (outward), con sus requisitos guardados en el SKILL.md.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { skillsForContext } from '../src/skills/builtin.js';
import { parseSkillMarkdown, SkillStore, TRASH_DIR } from '../src/skills/store.js';
import { createSkillsTool } from '../src/tools/skills.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

let dir = '';
let store: SkillStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-habilidades-'));
  store = new SkillStore({ dir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const draft = {
  name: 'Avisar de facturas',
  description: 'Avisa antes de cada cobro',
  category: 'casa',
  whenToUse: 'cuando llega una factura o una renovación',
  steps: ['buscar en el correo facturas y renovaciones', 'crear un recordatorio dos días antes'],
};

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((part) => part.text ?? '').join('\n');
}

describe('habilidades desde el chat', () => {
  it('desactivar la saca del contexto; activarla la devuelve', async () => {
    const id = store.save(draft);
    const tool = createSkillsTool({ store });
    const off = await tool.execute('c1', { action: 'disable', id }, undefined, undefined);
    expect(text(off)).toContain('ya no uso');
    expect(store.read(id)?.disabled).toBe(true);
    expect(skillsForContext(store.list(), 'tengo una factura')).toHaveLength(0);
    const listed = await tool.execute('c2', { action: 'list' }, undefined, undefined);
    expect(text(listed)).toContain('desactivada');
    await tool.execute('c3', { action: 'enable', id }, undefined, undefined);
    expect(store.read(id)?.disabled).toBeUndefined();
    expect(skillsForContext(store.list(), 'tengo una factura')).toHaveLength(1);
  });

  it('volver a guardarla no la reactiva sola', () => {
    const id = store.save(draft);
    store.setDisabled(id, true);
    store.save({ ...draft, steps: ['otro paso'] });
    expect(store.read(id)?.disabled).toBe(true);
  });

  it('borrar la manda a la papelera, recuperable, y list() no la ve', async () => {
    const id = store.save(draft);
    const tool = createSkillsTool({ store });
    const res = await tool.execute('c1', { action: 'remove', id }, undefined, undefined);
    expect(text(res)).toContain('papelera');
    expect(store.read(id)).toBeNull();
    expect(store.list()).toHaveLength(0);
    const trashed = readdirSync(join(dir, TRASH_DIR));
    expect(trashed).toHaveLength(1);
    expect(existsSync(join(dir, TRASH_DIR, trashed[0] ?? '', 'SKILL.md'))).toBe(true);
  });

  it('una habilidad que no existe se dice claro', async () => {
    const tool = createSkillsTool({ store });
    const res = await tool.execute('c1', { action: 'disable', id: 'nada' }, undefined, undefined);
    expect(text(res)).toContain('No tengo ninguna habilidad');
  });

  it('lo creado desde el chat pide permiso por defecto y guarda requisitos', async () => {
    const tool = createSkillsTool({ store });
    await tool.execute(
      'c1',
      { action: 'save', ...draft, needs: ['Correo', 'calendario'] },
      undefined,
      undefined,
    );
    const skill = store.read('avisar-de-facturas');
    expect(skill?.outward).toBe(true);
    expect(skill?.needs).toEqual(['correo', 'calendario']);
    const raw = readFileSync(store.fileFor('avisar-de-facturas'), 'utf8');
    expect(raw).toContain('outward: true');
    expect(raw).toContain('needs: correo, calendario');
    const listed = await tool.execute('c2', { action: 'list' }, undefined, undefined);
    expect(text(listed)).toContain('pide permiso');
  });

  it('solo un outward=false explícito la marca como de solo lectura', async () => {
    const tool = createSkillsTool({ store });
    await tool.execute('c1', { action: 'save', ...draft, outward: false }, undefined, undefined);
    expect(store.read('avisar-de-facturas')?.outward).toBe(false);
  });

  it('un SKILL.md sin las claves nuevas se lee igual (compatible agentskills)', () => {
    const skill = parseSkillMarkdown(
      'pdf',
      '---\nname: pdf\ndescription: Lee PDF\nlicense: Apache-2.0\n---\n\n## Steps\n\n- abrir\n',
    );
    expect(skill.disabled).toBeUndefined();
    expect(skill.outward).toBeUndefined();
    expect(skill.steps).toEqual(['abrir']);
  });
});
