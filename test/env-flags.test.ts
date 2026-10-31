import { describe, expect, it } from 'vitest';
import { envSwitch, envSwitchesDoctorLine } from '../src/env-flags.js';
import { semanticFromEnv } from '../src/memory/semantic.js';

const env = (o: Record<string, string>) => o as NodeJS.ProcessEnv;

describe('interruptores del .env escritos como una persona', () => {
  it('PA_SEMANTIC_RECALL se enciende con sí, true, yes u on', () => {
    for (const v of ['1', 'sí', 'si', 'Sí', 'true', 'TRUE', 'yes', 'on', ' 1 ']) {
      expect(semanticFromEnv('/tmp/models', env({ PA_SEMANTIC_RECALL: v }))).toBeDefined();
    }
  });

  it('PA_SEMANTIC_RECALL sigue apagado con 0, no, vacío o algo raro', () => {
    for (const v of ['0', 'no', 'false', 'off', '', 'quizá']) {
      expect(semanticFromEnv('/tmp/models', env({ PA_SEMANTIC_RECALL: v }))).toBeUndefined();
    }
    expect(semanticFromEnv('/tmp/models', env({}))).toBeUndefined();
  });

  it('envSwitch respeta el valor por defecto cuando no se entiende', () => {
    expect(envSwitch(undefined, true)).toBe(true);
    expect(envSwitch('quizá', false)).toBe(false);
    expect(envSwitch('No', true)).toBe(false);
    expect(envSwitch('apagado', true)).toBe(false);
  });

  it('pa doctor avisa solo de lo que no entiende', () => {
    expect(envSwitchesDoctorLine(env({}))).toBeUndefined();
    expect(envSwitchesDoctorLine(env({ PA_SEMANTIC_RECALL: 'sí' }))).toBeUndefined();
    expect(envSwitchesDoctorLine(env({ PA_SEMANTIC_RECALL: '0' }))).toBeUndefined();
    const line = envSwitchesDoctorLine(env({ PA_SEMANTIC_RECALL: 'quizá' }));
    expect(line).toContain('PA_SEMANTIC_RECALL «quizá»');
    expect(line).toContain('pon 1 para activarlo o 0 para apagarlo');
  });

  it('pa doctor no enseña caracteres raros ni textos largos del .env', () => {
    const line = envSwitchesDoctorLine(env({ PA_SEMANTIC_RECALL: `<b>${'x'.repeat(80)}` })) ?? '';
    expect(line).not.toContain('<');
    expect(line.length).toBeLessThan(160);
  });
});
