/**
 * Las habilidades importadas (/skills instalar) piden permiso antes de actuar
 * hacia fuera y no pisan una habilidad propia con el mismo nombre.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importedSkillDraft, installSkill, SkillImportError } from '../src/skills/import.js';
import { checkSkill } from '../src/skills/selfcheck.js';
import { SkillStore } from '../src/skills/store.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const MD = [
  '---',
  'name: Reservas por web',
  'description: Reserva mesa en un restaurante desde su web',
  '---',
  '1. Abrir la web del restaurante',
  '2. Rellenar el formulario y enviarlo',
].join('\n');

let dir = '';
let store: SkillStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-importadas-'));
  store = new SkillStore({ dir });
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

describe('habilidades importadas', () => {
  it('entran con outward: true y el chequeo avisa de que pedirá permiso', async () => {
    const meta = await installSkill(MD, async (text, m) => {
      store.save(importedSkillDraft(text, m, 'https://ejemplo.org/SKILL.md', store.read(m.id)));
    });
    const skill = store.read(meta.id);
    expect(skill?.outward).toBe(true);
    expect(skill?.category).toBe('importadas');
    expect(skill?.notes.join(' ')).toContain('https://ejemplo.org/SKILL.md');
    if (!skill) throw new Error('no guardada');
    const res = checkSkill(skill, { capabilities: new Set(), toolNames: [] });
    expect(res.summary).toContain('te pediré permiso');
  });

  it('se puede volver a importar encima de otra importada', async () => {
    const save = async (text: string, m: { id: string; name: string; description: string }) => {
      store.save(importedSkillDraft(text, m, 'https://ejemplo.org/SKILL.md', store.read(m.id)));
    };
    await installSkill(MD, save);
    await expect(installSkill(MD, save)).resolves.toMatchObject({ name: 'Reservas por web' });
  });

  it('no pisa una habilidad propia con el mismo nombre', async () => {
    const id = store.save({
      name: 'Reservas por web',
      description: 'La mía',
      category: 'reservas',
      whenToUse: 'cuando quiero reservar',
      steps: ['buscar la web', 'pedirme permiso antes de enviar'],
      outward: true,
    });
    const save = async (text: string, m: { id: string; name: string; description: string }) => {
      store.save(importedSkillDraft(text, m, 'https://ejemplo.org/SKILL.md', store.read(m.id)));
    };
    await expect(installSkill(MD, save)).rejects.toBeInstanceOf(SkillImportError);
    expect(store.read(id)?.description).toBe('La mía');
    expect(store.read(id)?.steps).toEqual(['buscar la web', 'pedirme permiso antes de enviar']);
  });
});
