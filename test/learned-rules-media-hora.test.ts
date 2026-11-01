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
  dir = mkdtempSync(join(tmpdir(), 'pa-learn-media-'));
  memory = new MemoryStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const texts = (): string[] => learnedRules(memory, [SCOPE]).map((e) => e.text);

describe('«media hora» = «30 min»: la misma regla con otras palabras no se duplica', () => {
  it('«Avísame media hora antes de las citas» y luego «Avísame 30 minutos antes de las citas»', () => {
    saveLearnedRule(memory, SCOPE, 'Avísame media hora antes de las citas');
    const r = saveLearnedRule(memory, SCOPE, 'Avísame 30 minutos antes de las citas');
    expect(r.status).toBe('updated');
    expect(texts()).toEqual(['Avísame 30 minutos antes de las citas']);
  });

  it('«Avísame una hora antes de las citas» y luego «Avísame 60 min antes de las citas»', () => {
    saveLearnedRule(memory, SCOPE, 'Avísame una hora antes de las citas');
    const r = saveLearnedRule(memory, SCOPE, 'Avísame 60 min antes de las citas');
    expect(r.status).toBe('updated');
    expect(texts()).toEqual(['Avísame 60 min antes de las citas']);
  });

  it('«Avísame hora y media antes de los vuelos» y luego «Avísame 90 min antes de los vuelos»', () => {
    saveLearnedRule(memory, SCOPE, 'Avísame hora y media antes de los vuelos');
    const r = saveLearnedRule(memory, SCOPE, 'Avísame 90 min antes de los vuelos');
    expect(r.status).toBe('updated');
    expect(texts()).toEqual(['Avísame 90 min antes de los vuelos']);
  });

  it('«Avísame dos horas y media antes de los vuelos» y luego «Avísame 150 minutos antes de los vuelos»', () => {
    saveLearnedRule(memory, SCOPE, 'Avísame dos horas y media antes de los vuelos');
    const r = saveLearnedRule(memory, SCOPE, 'Avísame 150 minutos antes de los vuelos');
    expect(r.status).toBe('updated');
    expect(texts()).toEqual(['Avísame 150 minutos antes de los vuelos']);
  });

  it('«Avísame un cuarto de hora antes de las citas» y luego «Avísame 15 min antes de las citas»', () => {
    saveLearnedRule(memory, SCOPE, 'Avísame un cuarto de hora antes de las citas');
    const r = saveLearnedRule(memory, SCOPE, 'Avísame 15 min antes de las citas');
    expect(r.status).toBe('updated');
    expect(texts()).toEqual(['Avísame 15 min antes de las citas']);
  });

  it('«Avísame tres cuartos de hora antes de las citas» y luego «Avísame 45 min antes de las citas»', () => {
    saveLearnedRule(memory, SCOPE, 'Avísame tres cuartos de hora antes de las citas');
    const r = saveLearnedRule(memory, SCOPE, 'Avísame 45 min antes de las citas');
    expect(r.status).toBe('updated');
    expect(texts()).toEqual(['Avísame 45 min antes de las citas']);
  });

  it('«Avísame 1,5 h antes de los vuelos» y luego «Avísame 90 minutos antes de los vuelos»', () => {
    saveLearnedRule(memory, SCOPE, 'Avísame 1,5 h antes de los vuelos');
    const r = saveLearnedRule(memory, SCOPE, 'Avísame 90 minutos antes de los vuelos');
    expect(r.status).toBe('updated');
    expect(texts()).toEqual(['Avísame 90 minutos antes de los vuelos']);
  });

  it('«media hora» y «10 min» siguen siendo reglas distintas', () => {
    saveLearnedRule(memory, SCOPE, 'Avísame media hora antes de las citas');
    const r = saveLearnedRule(memory, SCOPE, 'Avísame 10 min antes de las citas');
    expect(r.status).toBe('saved');
    expect(texts()).toHaveLength(2);
  });
});
