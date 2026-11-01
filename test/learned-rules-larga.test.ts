import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { learnedRules, learnFromTurn } from '../src/memory/learned-rules.js';
import { MemoryStore } from '../src/memory.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const SCOPE = 'telegram:dm:111#main';
let dir = '';
let memory: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-learn-larga-'));
  memory = new MemoryStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const texts = (): string[] => learnedRules(memory, [SCOPE]).map((e) => e.text);

const turn = (reply: string) =>
  learnFromTurn({ memory, scope: SCOPE, reply, hinted: true, tainted: false });

describe('regla demasiado larga: se le dice al dueño', () => {
  it('una regla de más de 200 letras no se guarda y la línea pide una más corta', () => {
    const rule = `Responde siempre ${'con mucho detalle '.repeat(14)}`;
    expect(rule.length).toBeGreaterThan(200);
    const r = turn(`Vale, lo tendré en cuenta.\n[[aprendido: ${rule}]]`);
    expect(r.text).toBe('Vale, lo tendré en cuenta.');
    expect(r.line).toMatch(/demasiado larga/);
    expect(r.line).toMatch(/más corta/);
    expect(texts()).toEqual([]);
  });

  it('con más de 400 letras la marca tampoco se cuela en la respuesta', () => {
    const rule = `Responde siempre ${'con mucho detalle '.repeat(30)}`;
    expect(rule.length).toBeGreaterThan(400);
    const r = turn(`Vale.\n[[aprendido: ${rule}]]`);
    expect(r.text).toBe('Vale.');
    expect(r.text).not.toMatch(/aprendido/);
    expect(r.line).toMatch(/demasiado larga/);
    expect(texts()).toEqual([]);
  });

  it('una regla normal se sigue guardando', () => {
    const r = turn('Vale.\n[[aprendido: Responde corto]]');
    expect(r.line).toMatch(/^📝 Aprendido: Responde corto/);
    expect(texts()).toEqual(['Responde corto']);
  });

  it('una marca vacía no dice nada', () => {
    const r = turn('Vale.\n[[aprendido: ]]');
    expect(r.line).toBeNull();
  });
});
