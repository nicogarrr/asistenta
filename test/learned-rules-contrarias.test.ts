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
  dir = mkdtempSync(join(tmpdir(), 'pa-learn-contra-'));
  memory = new MemoryStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const texts = (): string[] => learnedRules(memory, [SCOPE]).map((e) => e.text);

describe('reglas contrarias sin tema: gana la nueva', () => {
  it('«Usa emojis» y luego «No uses emojis» deja solo la nueva', () => {
    saveLearnedRule(memory, SCOPE, 'Usa emojis');
    const r = saveLearnedRule(memory, SCOPE, 'No uses emojis');
    expect(r.status).toBe('updated');
    expect(texts()).toEqual(['No uses emojis']);
  });

  it('y al revés: «Nunca añadas emojis» y luego «Añade emojis siempre»', () => {
    saveLearnedRule(memory, SCOPE, 'Nunca añadas emojis en las respuestas');
    const r = saveLearnedRule(memory, SCOPE, 'Añade emojis en las respuestas siempre');
    expect(r.status).toBe('updated');
    expect(texts()).toEqual(['Añade emojis en las respuestas siempre']);
  });

  it('«Responde sin emojis» sustituye a «Responde con emojis»', () => {
    saveLearnedRule(memory, SCOPE, 'Responde con emojis');
    saveLearnedRule(memory, SCOPE, 'Responde sin emojis');
    expect(texts()).toEqual(['Responde sin emojis']);
  });

  it('reglas distintas siguen siendo dos', () => {
    saveLearnedRule(memory, SCOPE, 'Usa emojis');
    saveLearnedRule(memory, SCOPE, 'Usa negritas para los títulos');
    saveLearnedRule(memory, SCOPE, 'Responde en español');
    saveLearnedRule(memory, SCOPE, 'Responde en inglés si te escribo en inglés');
    expect(texts()).toHaveLength(4);
  });

  it('con números distintos no se sustituyen aunque una diga «no»', () => {
    saveLearnedRule(memory, SCOPE, 'Avisar 10 min antes de las reuniones');
    const r = saveLearnedRule(memory, SCOPE, 'No avisar 30 min antes de las reuniones');
    expect(r.status).toBe('saved');
    expect(texts()).toHaveLength(2);
  });
});
