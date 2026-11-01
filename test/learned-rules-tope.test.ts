import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  forgetLearnedRule,
  formatLearnedRules,
  learnedRules,
  MAX_LEARNED_RULES,
  saveLearnedRule,
} from '../src/memory/learned-rules.js';
import { MemoryStore } from '../src/memory.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const SCOPE = 'telegram:dm:111#main';
let dir = '';
let memory: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-learn-tope-'));
  memory = new MemoryStore(dir);
  // La primera es la más vieja: con el tope lleno queda la última de /aprendido.
  saveLearnedRule(memory, SCOPE, 'Llamar al dueño Nico', 'nombre');
  for (let i = 2; i <= 20; i++) saveLearnedRule(memory, SCOPE, `Regla palabra${i}x`, `tema ${i}`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('todas las reglas guardadas se ven y se pueden borrar', () => {
  it('/aprendido enseña las 20 (antes solo 15 y «… y 5 más»)', () => {
    const text = formatLearnedRules(learnedRules(memory, [SCOPE]));
    expect(text).toContain('20. Llamar al dueño Nico');
    expect(text).not.toContain('más.');
  });

  it('/olvida 20 borra la más vieja, que también entra en los turnos', () => {
    expect(forgetLearnedRule(memory, [SCOPE], '20')).toBe('🗑️ Olvidada: Llamar al dueño Nico');
    expect(learnedRules(memory, [SCOPE])).toHaveLength(19);
    expect(forgetLearnedRule(memory, [SCOPE], String(MAX_LEARNED_RULES + 1))).toMatch(
      /^¿Cuál borro\? Dime su número \(del 1 al 19\)/,
    );
  });
});
