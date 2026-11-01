import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetLearnedRule, learnedRules, learnFromTurn } from '../src/memory/learned-rules.js';
import { MemoryStore } from '../src/memory.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const SCOPE = 'telegram:dm:111#main';
let dir = '';
let memory: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-learn-olvida-'));
  memory = new MemoryStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Turno con modelo falso en Telegram (con /olvida) o en el panel (sin él). */
function learn(topic: string, rule: string, telegram = true) {
  return learnFromTurn({
    memory,
    scope: SCOPE,
    reply: `Vale.\n[[aprendido: ${topic} | ${rule}]]`,
    hinted: true,
    tainted: false,
    ...(telegram ? { forgetScopes: [SCOPE] } : {}),
  });
}

describe('«📝 Aprendido» dice cómo borrarla', () => {
  it('en Telegram añade el número de /olvida, y ese número borra justo esa regla', () => {
    expect(learn('formato', 'Respuestas cortas').line).toBe(
      '📝 Aprendido: Respuestas cortas (si no la quieres, dime «olvida la regla 1»)',
    );
    expect(learn('saludo', 'Sin saludos al empezar').line).toBe(
      '📝 Aprendido: Sin saludos al empezar (si no la quieres, dime «olvida la regla 1»)',
    );
    expect(forgetLearnedRule(memory, [SCOPE], '1')).toBe('🗑️ Olvidada: Sin saludos al empezar');
    expect(learnedRules(memory, [SCOPE]).map((r) => r.text)).toEqual(['Respuestas cortas']);
  });

  it('una regla actualizada lleva el número que tiene en /aprendido', () => {
    learn('formato', 'Respuestas cortas');
    learn('saludo', 'Sin saludos al empezar');
    const out = learn('formato', 'Respuestas muy cortas');
    const n = Number(/olvida la regla (\d+)/.exec(out.line ?? '')?.[1]);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(forgetLearnedRule(memory, [SCOPE], String(n))).toBe('🗑️ Olvidada: Respuestas muy cortas');
  });

  it('sin los ámbitos de /aprendido la línea no lleva número', () => {
    expect(learn('formato', 'Respuestas cortas', false).line).toBe(
      '📝 Aprendido: Respuestas cortas',
    );
  });

  it('cableado: Telegram y el panel (que ya tiene /olvida) pasan los ámbitos de /aprendido', () => {
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(src).toMatch(
      /forgetScopes:\s*opts\.out && opts\.panel !== true \? undefined : memoryScopesFor\(thread\.key\)\.read,/,
    );
  });
});
