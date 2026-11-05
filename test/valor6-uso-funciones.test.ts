import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { funcionesText } from '../src/funciones.js';
import { SkillStore } from '../src/skills/store.js';
import type { Skill } from '../src/skills/types.js';
import { createSkillsTool } from '../src/tools/skills.js';
import {
  archivarText,
  archiveCandidates,
  isArchiveConfirm,
  SkillUsage,
  toolUseCounts,
  usoText,
} from '../src/uso-funciones.js';

const DAY = 24 * 3_600_000;
const NOW = Date.parse('2026-11-05T10:00:00Z');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-valor6-uso-'));
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

const iso = (ms: number) => new Date(ms).toISOString();

describe('uso de funciones', () => {
  it('cuenta del registro de auditoría solo lo permitido y dentro de los 30 días', () => {
    const c = toolUseCounts(
      [
        { tool: 'tiempo', verdict: 'allow', ts: iso(NOW - DAY) },
        { tool: 'tiempo', verdict: 'allow', ts: iso(NOW - 2 * DAY) },
        { tool: 'tiempo', verdict: 'allow', ts: iso(NOW - 40 * DAY) },
        { tool: 'mail', verdict: 'deny', ts: iso(NOW - DAY) },
      ],
      NOW - 30 * DAY,
    );
    expect(c.get('tiempo')).toEqual({ n: 2, last: NOW - DAY });
    expect(c.has('mail')).toBe(false);
  });

  it('apunta los usos de las habilidades en disco y aguanta un fichero roto', () => {
    const file = join(dir, 'skills', '.uso.json');
    const u = new SkillUsage(file);
    u.record('pedir-cita', NOW - DAY);
    u.record('pedir-cita', NOW);
    expect(new SkillUsage(file).all()['pedir-cita']).toEqual({ n: 2, last: NOW });
    writeFileSync(file, '{roto');
    expect(new SkillUsage(file).all()).toEqual({});
    new SkillUsage(file).record('x', NOW);
    expect(new SkillUsage(file).all().x?.n).toBe(1);
  });

  it('candidatas a archivar: aprendidas, viejas y sin usar; nunca las del asistente', () => {
    const skills = [
      skill('vieja-sin-uso'),
      skill('usada', {}),
      skill('nueva', { createdAt: NOW - 5 * DAY, updatedAt: NOW - 5 * DAY }),
      skill('oficial', { trust: 'official' }),
      skill('desactivada', { disabled: true }),
      skill('editada-hace-poco', { updatedAt: NOW - 3 * DAY }),
    ];
    const ids = archiveCandidates(skills, { usada: { n: 4, last: NOW - 2 * DAY } }, NOW).map(
      (s) => s.id,
    );
    expect(ids).toEqual(['vieja-sin-uso']);
  });

  it('/funciones uso: lo más usado con palabras de Nico y las que se pueden archivar', () => {
    const text = usoText({
      tools: new Map([
        ['tiempo', { n: 12, last: NOW }],
        ['reminder', { n: 30, last: NOW }],
        ['interna', { n: 99, last: NOW }],
      ]),
      toolText: (t) => (t === 'tiempo' ? 'el tiempo' : t === 'reminder' ? 'recordatorios' : null),
      skills: [skill('pedir-cita'), skill('vieja')],
      skillUse: { 'pedir-cita': { n: 3, last: NOW - DAY } },
      now: NOW,
    });
    expect(text).toMatch(/30× recordatorios\n• 12× el tiempo/);
    expect(text).not.toContain('interna');
    expect(text).toContain('Más usadas: pedir cita (3)');
    expect(text).toContain('Sin usar en 30 días: vieja');
    expect(text).toContain('/funciones archivar');
  });

  it('/funciones archivar enseña la lista primero y solo con «sí» las desactiva', () => {
    const off: string[] = [];
    const skills = [skill('vieja'), skill('otra-vieja')];
    const first = archivarText(skills, {}, NOW, false, (id) => off.push(id) > 0);
    expect(first).toContain('2 habilidades llevan más de 30 días');
    expect(first).toContain('/funciones archivar sí');
    expect(off).toEqual([]);
    const done = archivarText(skills, {}, NOW, true, (id) => off.push(id) > 0);
    expect(off).toEqual(['vieja', 'otra-vieja']);
    expect(done).toContain('Archivadas: vieja, otra vieja');
    expect(isArchiveConfirm('sí')).toBe(true);
    expect(isArchiveConfirm('Si, adelante')).toBe(true);
    expect(isArchiveConfirm('no')).toBe(false);
    expect(archivarText([], {}, NOW, false, () => true)).toContain('Nada que archivar');
  });

  it('leer una habilidad para seguirla cuenta un uso', async () => {
    const store = new SkillStore({ dir: join(dir, 'skills') });
    const id = store.save({
      name: 'Pedir cita',
      description: 'pide cita en el médico',
      category: 'salud',
      whenToUse: 'cuando pida cita',
      steps: ['abre la web'],
    });
    const used: string[] = [];
    const tool = createSkillsTool({ store, onUse: (x) => used.push(x) });
    await tool.execute('t1', { action: 'read', id }, undefined, undefined);
    await tool.execute('t2', { action: 'list' }, undefined, undefined);
    expect(used).toEqual([id]);
  });

  it('/funciones apunta a «/funciones uso» para el dueño', () => {
    expect(funcionesText({ owner: true })).toContain('/funciones uso');
    expect(funcionesText({ owner: false })).not.toContain('/funciones uso');
  });
});
