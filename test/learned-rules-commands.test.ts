import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HELP_SECTIONS } from '../src/channels/telegram-help.js';
import { funcionCommands } from '../src/funciones.js';
import {
  forgetLearnedRule,
  formatLearnedRules,
  learnedRules,
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
  dir = mkdtempSync(join(tmpdir(), 'pa-learn-cmd-'));
  memory = new MemoryStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('/aprendido y /olvida', () => {
  it('/aprendido lista las reglas, la más reciente primero', () => {
    expect(formatLearnedRules(learnedRules(memory, [SCOPE]))).toContain('Todavía no he aprendido');
    saveLearnedRule(memory, SCOPE, 'Responder corto', 'longitud');
    saveLearnedRule(memory, SCOPE, 'Llamar al dueño Nico', 'nombre');
    memory.remember(SCOPE, 'Su talla es la M'); // memoria normal: no sale
    const text = formatLearnedRules(learnedRules(memory, [SCOPE]));
    expect(text).toContain('1. Llamar al dueño Nico');
    expect(text).toContain('2. Responder corto');
    expect(text).not.toContain('talla');
    expect(text).toContain('Si quieres que olvide alguna, dime cuál.');
  });

  it('/olvida <n> borra esa regla y nada más', () => {
    saveLearnedRule(memory, SCOPE, 'Responder corto', 'longitud');
    saveLearnedRule(memory, SCOPE, 'Llamar al dueño Nico', 'nombre');
    expect(forgetLearnedRule(memory, [SCOPE], '1')).toBe('🗑️ Olvidada: Llamar al dueño Nico');
    expect(learnedRules(memory, [SCOPE]).map((e) => e.text)).toEqual(['Responder corto']);
    expect(forgetLearnedRule(memory, [SCOPE], '7')).toContain('¿Cuál borro?');
    expect(forgetLearnedRule(memory, [SCOPE], 'todo')).toContain('¿Cuál borro?');
    expect(learnedRules(memory, [SCOPE])).toHaveLength(1);
  });

  it('salen en /help y en /funciones (Memoria)', () => {
    const help = HELP_SECTIONS.flatMap((s) => s.entries.map((e) => e.command));
    expect(help).toEqual(expect.arrayContaining(['aprendido', 'olvida']));
    const fn = funcionCommands().filter((c) => c.command === 'aprendido' || c.command === 'olvida');
    expect(fn.map((c) => c.area)).toEqual(['memoria', 'memoria']);
  });
});
