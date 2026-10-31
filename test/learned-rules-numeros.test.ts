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
  dir = mkdtempSync(join(tmpdir(), 'pa-learn-num-'));
  memory = new MemoryStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const texts = (): string[] => learnedRules(memory, [SCOPE]).map((e) => e.text);

describe('los números cuentan en las reglas aprendidas', () => {
  it('«10 min antes» y «30 min antes» son dos reglas distintas', () => {
    saveLearnedRule(memory, SCOPE, 'Avisar 10 min antes de las reuniones');
    const r = saveLearnedRule(memory, SCOPE, 'Avisar 30 min antes de las reuniones');
    expect(r.status).toBe('saved');
    expect(texts()).toEqual([
      'Avisar 30 min antes de las reuniones',
      'Avisar 10 min antes de las reuniones',
    ]);
  });

  it('«2 opciones» y «3 opciones» tampoco se pisan', () => {
    saveLearnedRule(memory, SCOPE, 'Dame 2 opciones como mucho');
    saveLearnedRule(memory, SCOPE, 'Dame 3 opciones como mucho');
    expect(texts()).toHaveLength(2);
  });

  it('la misma regla con el mismo número se actualiza y no se duplica', () => {
    saveLearnedRule(memory, SCOPE, 'Avisar 10 min antes de las reuniones');
    const r = saveLearnedRule(memory, SCOPE, 'avisar 10 min antes de las reuniones');
    expect(r.status).toBe('updated');
    expect(texts()).toEqual(['avisar 10 min antes de las reuniones']);
  });

  it('con el mismo tema la nueva sigue sustituyendo aunque cambie el número', () => {
    saveLearnedRule(memory, SCOPE, 'Avisar 10 min antes de las reuniones', 'aviso reuniones');
    const r = saveLearnedRule(
      memory,
      SCOPE,
      'Avisar 30 min antes de las reuniones',
      'aviso reuniones',
    );
    expect(r.status).toBe('updated');
    expect(texts()).toEqual(['Avisar 30 min antes de las reuniones']);
  });
});
