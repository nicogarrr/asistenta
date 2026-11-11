import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSkillMarkdown, SkillStore, serializeSkillMarkdown } from '../src/skills/store.js';
import type { Skill } from '../src/skills/types.js';
import { createSkillsTool } from '../src/tools/skills.js';
import {
  archivarText,
  archiveCandidates,
  fijarText,
  findLearnedSkill,
  pinSubcommand,
  usoText,
} from '../src/uso-funciones.js';

const DAY = 24 * 3_600_000;
const NOW = Date.parse('2026-11-11T10:00:00Z');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-gaps11-fijar-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function skill(id: string, over: Partial<Skill> = {}): Skill {
  return {
    id,
    name: id.replace(/-/g, ' '),
    description: `hace ${id}`,
    category: 'general',
    whenToUse: '',
    steps: ['uno'],
    notes: [],
    version: 1,
    createdAt: NOW - 90 * DAY,
    updatedAt: NOW - 90 * DAY,
    trust: 'community',
    ...over,
  };
}

describe('fijar habilidades (lock del curador de Hermes)', () => {
  it('una habilidad fijada no sale como candidata a archivar', () => {
    const skills = [skill('informe-cartera', { pinned: true }), skill('pedir-pizza')];
    expect(archiveCandidates(skills, {}, NOW).map((s) => s.id)).toEqual(['pedir-pizza']);
    const disabled: string[] = [];
    const out = archivarText(skills, {}, NOW, true, (id) => {
      disabled.push(id);
      return true;
    });
    expect(disabled).toEqual(['pedir-pizza']);
    expect(out).not.toContain('informe cartera');
  });

  it('pinned sobrevive al fichero, a save() y a improve()', () => {
    const md = serializeSkillMarkdown(skill('informe-cartera', { pinned: true }));
    expect(md).toContain('pinned: true');
    expect(parseSkillMarkdown('informe-cartera', md).pinned).toBe(true);
    expect(parseSkillMarkdown('x', serializeSkillMarkdown(skill('x'))).pinned).toBeUndefined();

    const store = new SkillStore({ dir });
    const id = store.save({
      name: 'Informe cartera',
      description: 'd',
      category: 'general',
      whenToUse: 'w',
      steps: ['a'],
    });
    expect(store.setPinned(id, true)).toBe(true);
    store.save({
      name: 'Informe cartera',
      description: 'd2',
      category: 'general',
      whenToUse: 'w',
      steps: ['b'],
    });
    expect(store.read(id)?.pinned).toBe(true);
    store.improve(id, ['c'], 'mejor');
    expect(store.read(id)?.pinned).toBe(true);
    expect(readFileSync(join(dir, id, 'SKILL.md'), 'utf8')).toContain('pinned: true');
    expect(store.setPinned(id, false)).toBe(true);
    expect(store.read(id)?.pinned).toBeUndefined();
    expect(store.setPinned('no-existe', true)).toBe(false);
  });

  it('/funciones fijar <nombre> busca por nombre sin acentos y fija', () => {
    const skills = [skill('resumen-mercados', { name: 'Resumen de mercados' }), skill('otra')];
    const calls: [string, boolean][] = [];
    const set = (id: string, p: boolean) => {
      calls.push([id, p]);
      return true;
    };
    const out = fijarText(skills, 'resumen de MERCADOS', true, set);
    expect(calls).toEqual([['resumen-mercados', true]]);
    expect(out).toContain('📌 Fijada «Resumen de mercados»');
    expect(findLearnedSkill(skills, 'mercados')?.id).toBe('resumen-mercados');
  });

  it('no fija las oficiales ni inventa: nombre desconocido o ambiguo → lista', () => {
    const skills = [
      skill('oficial', { trust: 'official' }),
      skill('correo-gestor'),
      skill('correo-banco'),
    ];
    const set = () => {
      throw new Error('no debería llamarse');
    };
    expect(fijarText(skills, 'oficial', true, set)).toContain('No encuentro');
    expect(fijarText(skills, 'correo', true, set)).toContain('No encuentro');
    expect(fijarText(skills, 'correo gestor', true, () => true)).toContain('Fijada');
  });

  it('sin nombre lista las fijadas; soltar y repetir dicen el estado', () => {
    const skills = [skill('a', { pinned: true }), skill('b')];
    expect(fijarText(skills, '', true, () => true)).toContain('• a');
    expect(fijarText([skill('b')], '', true, () => true)).toContain('No tienes ninguna');
    expect(fijarText(skills, 'a', true, () => true)).toContain('ya estaba fijada');
    expect(fijarText(skills, 'b', false, () => true)).toContain('no estaba fijada');
    expect(fijarText(skills, 'a', false, () => true)).toContain('Soltada «a»');
  });

  it('subcomandos', () => {
    expect(pinSubcommand('fijar')).toBe(true);
    expect(pinSubcommand('fíjala')).toBe(true);
    expect(pinSubcommand('soltar')).toBe(false);
    expect(pinSubcommand('desfijar')).toBe(false);
    expect(pinSubcommand('uso')).toBeNull();
  });

  it('/funciones uso enseña las fijadas y cómo fijar', () => {
    const text = usoText({
      tools: new Map(),
      toolText: () => null,
      skills: [skill('a', { pinned: true }), skill('b')],
      skillUse: {},
      now: NOW,
    });
    expect(text).toContain('📌 Fijadas (nunca se archivan): a');
    expect(text).toContain('Sin usar en 30 días: b');
    expect(text).toContain('/funciones fijar');
  });

  it('la herramienta skills fija y suelta con action=pin/unpin', async () => {
    const store = new SkillStore({ dir });
    const id = store.save({
      name: 'Mi rutina',
      description: 'd',
      category: 'general',
      whenToUse: 'w',
      steps: ['a'],
    });
    const tool = createSkillsTool({ store });
    const r = await tool.execute('t1', { action: 'pin', id }, undefined, undefined);
    expect(JSON.stringify(r.content)).toContain('Fijada');
    expect(store.read(id)?.pinned).toBe(true);
    await tool.execute('t2', { action: 'unpin', id }, undefined, undefined);
    expect(store.read(id)?.pinned).toBeUndefined();
    const miss = await tool.execute('t3', { action: 'pin', id: 'nada' }, undefined, undefined);
    expect(JSON.stringify(miss.content)).toContain('No tengo');
  });
});
