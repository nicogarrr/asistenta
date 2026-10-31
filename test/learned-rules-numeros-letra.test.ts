import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { learnedRules, saveLearnedRule } from '../src/memory/learned-rules.js';
import { MemoryStore } from '../src/memory.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const SCOPE = 'telegram:dm:111#main';
let dir = '';
let memory: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-learn-numletra-'));
  memory = new MemoryStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const texts = (): string[] => learnedRules(memory, [SCOPE]).map((e) => e.text);

describe('números con letra en las reglas aprendidas', () => {
  it('«diez minutos» es lo mismo que «10 min»', () => {
    saveLearnedRule(memory, SCOPE, 'Avisar 10 min antes de las reuniones');
    const r = saveLearnedRule(memory, SCOPE, 'Avisar diez minutos antes de las reuniones');
    expect(r.status).toBe('updated');
    expect(texts()).toEqual(['Avisar diez minutos antes de las reuniones']);
  });

  it('«treinta y cinco minutos» = «35 min» y «una hora» = «1 h»', () => {
    saveLearnedRule(memory, SCOPE, 'Recordar la medicina 35 min después de comer');
    saveLearnedRule(memory, SCOPE, 'Recordar la medicina treinta y cinco minutos después de comer');
    saveLearnedRule(memory, SCOPE, 'Avisar 1 h antes del tren');
    saveLearnedRule(memory, SCOPE, 'Avisar una hora antes del tren');
    expect(texts()).toEqual([
      'Avisar una hora antes del tren',
      'Recordar la medicina treinta y cinco minutos después de comer',
    ]);
  });

  it('«diez minutos» y «30 min» siguen siendo distintas', () => {
    saveLearnedRule(memory, SCOPE, 'Avisar diez minutos antes de las reuniones');
    const r = saveLearnedRule(memory, SCOPE, 'Avisar 30 min antes de las reuniones');
    expect(r.status).toBe('saved');
    expect(texts()).toHaveLength(2);
  });

  it('«una» que no va con una unidad no es un número', () => {
    saveLearnedRule(memory, SCOPE, 'Dame una lista corta');
    const r = saveLearnedRule(memory, SCOPE, 'Dame 1 lista corta');
    expect(r.status).toBe('saved');
  });
});
