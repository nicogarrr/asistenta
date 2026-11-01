/**
 * Las habilidades generales sembradas (facturas, viajes, reservas, cumpleaños,
 * casa, notas de voz): se siembran una vez, no pisan ediciones, las que actúan
 * fuera piden permiso y el auto-chequeo dice cuáles se pueden usar hoy.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GENERAL_SKILLS, seedGeneralSkills } from '../src/skills/general.js';
import { checkSkill } from '../src/skills/selfcheck.js';
import { SkillStore } from '../src/skills/store.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

let dir = '';
let store: SkillStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-general-'));
  store = new SkillStore({ dir });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('habilidades generales sembradas', () => {
  it('siembra las siete una vez y no pisa una edición ni una desactivada', () => {
    expect(seedGeneralSkills(store, {})).toHaveLength(7);
    store.improve('cumpleanos', ['solo avisar'], 'lo quiere más simple');
    store.setDisabled('casa-inteligente', true);
    expect(seedGeneralSkills(store, {})).toHaveLength(0);
    expect(store.read('cumpleanos')?.steps).toEqual(['solo avisar']);
    expect(store.read('casa-inteligente')?.disabled).toBe(true);
  });

  it('PA_GENERAL_SKILLS=0 no siembra nada', () => {
    expect(seedGeneralSkills(store, { PA_GENERAL_SKILLS: '0' })).toEqual([]);
    expect(store.list()).toHaveLength(0);
  });

  it('las que envían, reservan o encienden piden permiso y lo dicen en sus pasos', () => {
    seedGeneralSkills(store, {});
    for (const id of ['reservas-por-web', 'cumpleanos', 'casa-inteligente']) {
      const skill = store.read(id);
      expect(skill?.outward).toBe(true);
      expect(skill?.steps.join(' ')).toMatch(/permiso|aprueba/);
    }
    expect(readFileSync(store.fileFor('reservas-por-web'), 'utf8')).toContain('outward: true');
  });

  it('el auto-chequeo dice cuáles funcionan con lo configurado', () => {
    seedGeneralSkills(store, {});
    const caps = new Set(['correo', 'navegador']);
    const ready = store
      .list()
      .filter((skill) => checkSkill(skill, { capabilities: caps, toolNames: [] }).ready)
      .map((skill) => skill.id);
    expect(ready).toEqual([
      'cuestionario-para-otra-persona',
      'facturas-y-suscripciones',
      'reservas-por-web',
      'viajes',
    ]);
    const casa = store.read('casa-inteligente');
    if (!casa) throw new Error('falta casa');
    expect(checkSkill(casa, { capabilities: caps }).summary).toContain('falta configurar casa');
  });

  it('ninguna promete pagar ni enviar sin preguntar', () => {
    const all = GENERAL_SKILLS.flatMap((skill) => skill.steps).join(' ');
    expect(all).not.toMatch(/\bpagar\b(?! ni)/);
    expect(all).toContain('nunca pagar');
  });

  // Hasta donde se puede probar con fakes: falta saber en el daemon qué está
  // configurado (correo, calendario, Home Assistant, transcripción) para pasarlo
  // al auto-chequeo; hoy, sin esa conexión, dice «sin comprobar».
  it.todo(
    'el daemon pasa al auto-chequeo lo que hay configurado (correo, calendario, casa, notas de voz)',
  );
  it.todo(
    'casa: herramienta de Home Assistant local (solo si PA tiene su URL y token en el vault)',
  );
  it.todo(
    'facturas/viajes: recordatorio creado tras el «sí» del dueño, con correo falso de extremo a extremo',
  );
});
