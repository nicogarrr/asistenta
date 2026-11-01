import { describe, expect, it } from 'vitest';
import { GENERAL_SKILLS } from '../src/skills/general.js';
import { slugify } from '../src/skills/store.js';

describe('cuestionario para otra persona (to-questionnaire)', () => {
  const skill = GENERAL_SKILLS.find((s) => slugify(s.name) === 'cuestionario-para-otra-persona');

  it('viene sembrada, no envía nada sola y da crédito a Matt Pocock', () => {
    expect(skill).toBeDefined();
    expect(skill?.outward).toBe(false);
    expect(skill?.notes?.join(' ')).toMatch(/Matt Pocock.*MIT/);
    expect(skill?.whenToUse).toMatch(/gestor/);
  });

  it('pregunta solo a quién va y para qué, y ordena por importancia', () => {
    const steps = skill?.steps.join(' ') ?? '';
    expect(steps).toMatch(/a quién va/);
    expect(steps).toMatch(/más a menos importante/);
    expect(steps).toMatch(/no enviarlo a nadie/);
  });
});
