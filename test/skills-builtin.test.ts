import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_SKILL_IDS,
  CODING_CATEGORY,
  looksLikeCoding,
  seedBuiltinSkills,
  skillsForContext,
} from '../src/skills/builtin.js';
import { skillsIndex } from '../src/skills/lessons.js';
import { SkillStore } from '../src/skills/store.js';

const dirs: string[] = [];
function store(): SkillStore {
  const dir = mkdtempSync(join(tmpdir(), 'skills-builtin-'));
  dirs.push(dir);
  return new SkillStore({ dir });
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('skills de ingeniería incluidas (ROADMAP)', () => {
  it('siembra diagnosticar-bugs y TDD en una tienda vacía', () => {
    const s = store();
    const created = seedBuiltinSkills(s, {});
    expect(created.sort()).toEqual([...BUILTIN_SKILL_IDS].sort());
    for (const id of BUILTIN_SKILL_IDS) {
      const skill = s.read(id);
      expect(skill?.category).toBe(CODING_CATEGORY);
      expect(skill?.steps.length).toBeGreaterThanOrEqual(4);
    }
  });

  it('es idempotente y nunca pisa una edición del usuario', () => {
    const s = store();
    seedBuiltinSkills(s, {});
    const id = BUILTIN_SKILL_IDS[0] as string;
    const file = s.fileFor(id);
    const edited = readFileSync(file, 'utf8').replace(/version: \d+/, 'version: 7');
    writeFileSync(file, edited);
    expect(seedBuiltinSkills(s, {})).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe(edited);
    expect(s.read(id)?.version).toBe(7);
  });

  it('PA_BUILTIN_SKILLS=0 no siembra nada', () => {
    const s = store();
    expect(seedBuiltinSkills(s, { PA_BUILTIN_SKILLS: '0' })).toEqual([]);
    expect(s.list()).toEqual([]);
  });

  it('detecta peticiones de programación y no la charla normal', () => {
    for (const q of [
      'arregla este bug en el parser',
      'el test de vitest está rojo',
      'mira src/cli.ts y dime qué falla',
      'haz un commit con esto',
      'refactoriza esta función en python',
    ]) {
      expect(looksLikeCoding(q), q).toBe(true);
    }
    for (const q of [
      '¿qué tiempo hace mañana en Madrid?',
      'recuérdame llamar a mamá a las 18:00',
      'resume el correo de Laura',
      undefined,
    ]) {
      expect(looksLikeCoding(q), String(q)).toBe(false);
    }
  });

  it('el índice del contexto solo lleva las de programación al programar', () => {
    const s = store();
    seedBuiltinSkills(s, {});
    s.save({
      name: 'Reservar mesa',
      description: 'Reservas de restaurante',
      category: 'general',
      whenToUse: 'Reservar un restaurante',
      steps: ['Busca disponibilidad'],
    });
    const chat = skillsIndex(skillsForContext(s.list(), 'reserva mesa para el viernes'));
    expect(chat).toContain('reservar-mesa');
    for (const id of BUILTIN_SKILL_IDS) expect(chat).not.toContain(id);

    const coding = skillsIndex(skillsForContext(s.list(), 'arregla el bug del test rojo'));
    expect(coding).toContain('reservar-mesa');
    for (const id of BUILTIN_SKILL_IDS) expect(coding).toContain(id);
  });
});
