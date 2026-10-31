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
  dir = mkdtempSync(join(tmpdir(), 'pa-learn-pron-'));
  memory = new MemoryStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const texts = (): string[] => learnedRules(memory, [SCOPE]).map((e) => e.text);

describe('pronombre pegado: «avísame» y «no me avises» son la misma regla', () => {
  it('«Avísame antes de las reuniones» y luego «No me avises antes de las reuniones» deja solo la nueva', () => {
    saveLearnedRule(memory, SCOPE, 'Avísame antes de las reuniones');
    const r = saveLearnedRule(memory, SCOPE, 'No me avises antes de las reuniones');
    expect(r.status).toBe('updated');
    expect(texts()).toEqual(['No me avises antes de las reuniones']);
  });

  it('«Llámame por mi nombre» y luego «No me llames por mi nombre» deja solo la nueva', () => {
    saveLearnedRule(memory, SCOPE, 'Llámame por mi nombre');
    const r = saveLearnedRule(memory, SCOPE, 'No me llames por mi nombre');
    expect(r.status).toBe('updated');
    expect(texts()).toEqual(['No me llames por mi nombre']);
  });

  it('«No me hables de usted» y luego «Háblame de usted» deja solo la nueva', () => {
    saveLearnedRule(memory, SCOPE, 'No me hables de usted');
    const r = saveLearnedRule(memory, SCOPE, 'Háblame de usted');
    expect(r.status).toBe('updated');
    expect(texts()).toEqual(['Háblame de usted']);
  });

  it('«Cuéntame los chistes que veas» y luego «No me cuentes los chistes que veas» deja solo la nueva', () => {
    saveLearnedRule(memory, SCOPE, 'Cuéntame los chistes que veas');
    const r = saveLearnedRule(memory, SCOPE, 'No me cuentes los chistes que veas');
    expect(r.status).toBe('updated');
    expect(texts()).toEqual(['No me cuentes los chistes que veas']);
  });

  it('«No me escribas en mayúsculas» y luego «Escríbeme en mayúsculas» deja solo la nueva', () => {
    saveLearnedRule(memory, SCOPE, 'No me escribas en mayúsculas');
    const r = saveLearnedRule(memory, SCOPE, 'Escríbeme en mayúsculas');
    expect(r.status).toBe('updated');
    expect(texts()).toEqual(['Escríbeme en mayúsculas']);
  });

  it('reglas distintas con el mismo verbo se quedan las dos', () => {
    saveLearnedRule(memory, SCOPE, 'Avísame antes de las reuniones');
    const r = saveLearnedRule(memory, SCOPE, 'Avísame cuando llegue un paquete');
    expect(r.status).toBe('saved');
    expect(texts()).toHaveLength(2);
  });

  it('«Pon tomate en la lista» y «Toma nota de las reuniones» se quedan las dos', () => {
    saveLearnedRule(memory, SCOPE, 'Pon tomate en la lista');
    const r = saveLearnedRule(memory, SCOPE, 'Toma nota de las reuniones');
    expect(r.status).toBe('saved');
  });
});
