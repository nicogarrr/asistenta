import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetLearnedRule, learnedRules, saveLearnedRule } from '../src/memory/learned-rules.js';
import { MemoryStore } from '../src/memory.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const SCOPE = 'telegram:dm:111#main';
let dir = '';
let memory: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-learn-olvida-texto-'));
  memory = new MemoryStore(dir);
  saveLearnedRule(memory, SCOPE, 'Responde sin emojis');
  saveLearnedRule(memory, SCOPE, 'Avisar 10 min antes de las reuniones');
  saveLearnedRule(memory, SCOPE, 'Resume las reuniones largas en tres puntos');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const texts = (): string[] => learnedRules(memory, [SCOPE]).map((e) => e.text);

describe('/olvida por texto', () => {
  it('«/olvida emojis» borra la única regla que lo dice', () => {
    expect(forgetLearnedRule(memory, [SCOPE], 'emojis')).toBe('🗑️ Olvidada: Responde sin emojis');
    expect(texts()).not.toContain('Responde sin emojis');
  });

  it('sin tildes ni mayúsculas: «/olvida Emojís»', () => {
    expect(forgetLearnedRule(memory, [SCOPE], 'Emojís')).toContain('Olvidada');
  });

  it('si lo dicen varias, pregunta cuál y no borra nada', () => {
    const r = forgetLearnedRule(memory, [SCOPE], 'reuniones');
    expect(r).toContain('Hay 2 reglas');
    expect(r).toContain('1. Resume las reuniones largas en tres puntos');
    expect(r).toContain('2. Avisar 10 min antes de las reuniones');
    expect(texts()).toHaveLength(3);
  });

  it('«/olvida 2.» también vale y lo que no está da el uso', () => {
    expect(forgetLearnedRule(memory, [SCOPE], '2.')).toContain('Olvidada: Avisar 10 min');
    expect(forgetLearnedRule(memory, [SCOPE], 'tortilla')).toContain('Uso: /olvida');
    expect(texts()).toHaveLength(2);
  });
});
