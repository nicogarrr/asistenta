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
  dir = mkdtempSync(join(tmpdir(), 'pa-learn-irreg-'));
  memory = new MemoryStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const texts = (): string[] => learnedRules(memory, [SCOPE]).map((e) => e.text);

describe('imperativos irregulares: «pon» y «no pongas» son la misma regla', () => {
  it('«Pon emojis» y luego «No pongas emojis» deja solo la nueva', () => {
    saveLearnedRule(memory, SCOPE, 'Pon emojis');
    const r = saveLearnedRule(memory, SCOPE, 'No pongas emojis');
    expect(r.status).toBe('updated');
    expect(texts()).toEqual(['No pongas emojis']);
  });

  it('«Haz resúmenes cortos» y luego «No hagas resúmenes cortos»', () => {
    saveLearnedRule(memory, SCOPE, 'Haz resúmenes cortos');
    const r = saveLearnedRule(memory, SCOPE, 'No hagas resúmenes cortos');
    expect(r.status).toBe('updated');
    expect(texts()).toEqual(['No hagas resúmenes cortos']);
  });

  it('«Dime la hora exacta» y luego «No me digas la hora exacta»', () => {
    saveLearnedRule(memory, SCOPE, 'Dime la hora exacta');
    const r = saveLearnedRule(memory, SCOPE, 'No me digas la hora exacta');
    expect(r.status).toBe('updated');
    expect(texts()).toEqual(['No me digas la hora exacta']);
  });

  it('con pronombre pegado: «Ponme la temperatura» y «No me pongas la temperatura»', () => {
    saveLearnedRule(memory, SCOPE, 'No me pongas la temperatura');
    const r = saveLearnedRule(memory, SCOPE, 'Ponme la temperatura');
    expect(r.status).toBe('updated');
    expect(texts()).toEqual(['Ponme la temperatura']);
  });

  it('«Ten paciencia con las listas» y «No tengas paciencia con las listas»', () => {
    saveLearnedRule(memory, SCOPE, 'Ten paciencia con las listas');
    const r = saveLearnedRule(memory, SCOPE, 'No tengas paciencia con las listas');
    expect(r.status).toBe('updated');
    expect(texts()).toEqual(['No tengas paciencia con las listas']);
  });

  it('reglas distintas con el mismo verbo se quedan las dos', () => {
    saveLearnedRule(memory, SCOPE, 'Pon emojis');
    const r = saveLearnedRule(memory, SCOPE, 'Pon la hora en formato largo');
    expect(r.status).toBe('saved');
    expect(texts()).toEqual(['Pon la hora en formato largo', 'Pon emojis']);
  });

  it('«Di siempre la temperatura» y «No digas el pronóstico» se quedan las dos', () => {
    saveLearnedRule(memory, SCOPE, 'Di siempre la temperatura');
    const r = saveLearnedRule(memory, SCOPE, 'No digas el pronóstico');
    expect(r.status).toBe('saved');
    expect(texts()).toHaveLength(2);
  });
});
