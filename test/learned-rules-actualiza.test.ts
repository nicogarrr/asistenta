import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { learnedRules, MAX_LEARNED_RULES, saveLearnedRule } from '../src/memory/learned-rules.js';
import { MemoryStore } from '../src/memory.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const SCOPE = 'telegram:dm:111#main';
let dir = '';
let memory: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-learn-update-'));
  memory = new MemoryStore(dir);
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const texts = () => learnedRules(memory, [SCOPE]).map((e) => e.text);

describe('una regla actualizada cuenta como la más reciente', () => {
  it('sube a la primera posición de /aprendido con la fecha de hoy', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
    saveLearnedRule(memory, SCOPE, 'Respuestas largas', 'longitud');
    saveLearnedRule(memory, SCOPE, 'Sin emojis', 'emojis');
    vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
    expect(saveLearnedRule(memory, SCOPE, 'Respuestas cortas', 'longitud').status).toBe('updated');
    const rules = learnedRules(memory, [SCOPE]);
    expect(rules.map((e) => e.text)).toEqual(['Respuestas cortas', 'Sin emojis']);
    expect(rules[0]?.date).toBe('2026-10-20');
  });

  it('el tope no olvida la corrección que el dueño acaba de repetir', () => {
    saveLearnedRule(memory, SCOPE, 'Llamar al dueño Nico', 'nombre');
    for (let i = 1; i < MAX_LEARNED_RULES; i++) {
      saveLearnedRule(memory, SCOPE, `Regla palabra${i}x`, `tema ${i}`);
    }
    // La más vieja se reafirma hoy; luego llega una regla nueva y el tope tiene que olvidar una.
    saveLearnedRule(memory, SCOPE, 'Llamar siempre al dueño Nico', 'nombre');
    saveLearnedRule(memory, SCOPE, 'Sin saludos al empezar', 'saludo');
    expect(texts()).toHaveLength(MAX_LEARNED_RULES);
    expect(texts()).toContain('Llamar siempre al dueño Nico');
    expect(texts()).not.toContain('Regla palabra1x');
  });

  it('sustituye a todas las que decían lo mismo, no solo a una', () => {
    saveLearnedRule(memory, SCOPE, 'Respuestas cortas sin listas', 'formato');
    saveLearnedRule(memory, SCOPE, 'Nunca usar listas', 'listas');
    // Mismo tema que la segunda y casi el mismo texto que la primera.
    saveLearnedRule(memory, SCOPE, 'Respuestas cortas sin listas nunca', 'listas');
    expect(texts()).toEqual(['Respuestas cortas sin listas nunca']);
  });
});
