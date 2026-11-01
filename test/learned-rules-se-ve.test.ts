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
  dir = mkdtempSync(join(tmpdir(), 'pa-learn-se-'));
  memory = new MemoryStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const texts = (): string[] => learnedRules(memory, [SCOPE]).map((e) => e.text);

describe('«sé» y «ve»: «Sé breve» y «No seas breve» son la misma regla', () => {
  it('«Sé breve» y luego «No seas breve» deja solo la nueva', () => {
    saveLearnedRule(memory, SCOPE, 'Sé breve');
    const r = saveLearnedRule(memory, SCOPE, 'No seas breve');
    expect(r.status).toBe('updated');
    expect(texts()).toEqual(['No seas breve']);
  });

  it('«No seas tan formal en los correos» y luego «Sé formal en los correos» deja solo la nueva', () => {
    saveLearnedRule(memory, SCOPE, 'No seas tan formal en los correos');
    const r = saveLearnedRule(memory, SCOPE, 'Sé formal en los correos');
    expect(r.status).toBe('updated');
    expect(texts()).toEqual(['Sé formal en los correos']);
  });

  it('«Ve al grano» y luego «No vayas al grano» deja solo la nueva', () => {
    saveLearnedRule(memory, SCOPE, 'Ve al grano');
    const r = saveLearnedRule(memory, SCOPE, 'No vayas al grano');
    expect(r.status).toBe('updated');
    expect(texts()).toEqual(['No vayas al grano']);
  });

  it('el «se» de en medio no cuenta como «sé»', () => {
    saveLearnedRule(memory, SCOPE, 'Sé breve');
    const r = saveLearnedRule(memory, SCOPE, 'Breve se queda corto en los informes');
    expect(r.status).toBe('saved');
    expect(texts()).toHaveLength(2);
  });
});
