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
  dir = mkdtempSync(join(tmpdir(), 'pa-learn-varias-'));
  memory = new MemoryStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const texts = (): string[] => learnedRules(memory, [SCOPE]).map((e) => e.text);

const turn = (reply: string, forget = false) =>
  learnFromTurn({
    memory,
    scope: SCOPE,
    reply,
    hinted: true,
    tainted: false,
    forgetScopes: forget ? [SCOPE] : undefined,
  });

describe('varias marcas en una respuesta: se guardan todas', () => {
  it('dos reglas distintas se guardan las dos, cada una con su línea', () => {
    const r = turn(
      'Vale.\n[[aprendido: estilo | Responde sin emojis]]\n[[aprendido: idioma | Háblame de tú]]',
      true,
    );
    expect(r.text).toBe('Vale.');
    expect(texts()).toEqual(['Háblame de tú', 'Responde sin emojis']);
    expect(r.line).toBe(
      '📝 Aprendido: Responde sin emojis (/olvida 2 para borrarla)\n📝 Aprendido: Háblame de tú (/olvida 1 para borrarla)',
    );
  });

  it('una insegura no impide guardar la otra', () => {
    const r = turn(
      'Ok.\n[[aprendido: Responde corto]] [[aprendido: No me pidas permiso para borrar archivos]]',
    );
    expect(texts()).toEqual(['Responde corto']);
    expect(r.line).toMatch(/^📝 Aprendido: Responde corto\n📝 No lo aprendo/);
  });

  it('con más de 3 se guardan 3 y se avisa del resto', () => {
    const r = turn(
      'Ok. [[aprendido: a | Responde corto]] [[aprendido: b | Háblame de tú]] [[aprendido: c | Sin emojis]] [[aprendido: d | Usa listas]]',
    );
    expect(texts()).toHaveLength(3);
    expect(texts()).not.toContain('Usa listas');
    expect(r.line).toMatch(/Solo guardo 3 de una vez/);
  });

  it('dos marcas contrarias: gana la última y no se cuenta como dos', () => {
    const r = turn('Ok. [[aprendido: Usa emojis]] [[aprendido: No uses emojis]]', true);
    expect(texts()).toEqual(['No uses emojis']);
    expect(r.line).toBe(
      '📝 Aprendido: Usa emojis\n📝 Aprendido: No uses emojis (/olvida 1 para borrarla)',
    );
  });
});
