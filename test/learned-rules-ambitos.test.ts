import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { learnedRules, learnFromTurn, saveLearnedRule } from '../src/memory/learned-rules.js';
import { MemoryStore, memoryScopesFor } from '../src/memory.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

// Un hilo de Telegram: escribe en #main y /aprendido lee #main + el hilo.
const { write, read } = memoryScopesFor('telegram:dm:111#viaje');
let dir = '';
let memory: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-learn-scope-'));
  memory = new MemoryStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const shown = (): string[] => learnedRules(memory, read).map((e) => e.text);

describe('reglas iguales en otro ámbito que enseña /aprendido', () => {
  it('una regla igual guardada en el hilo se sustituye, no sale dos veces', () => {
    memory.remember(read[1] as string, 'Responder siempre en español', { tags: ['aprendido'] });
    const r = saveLearnedRule(memory, write, 'Responder siempre en español', null, read);
    expect(r.status).toBe('updated');
    expect(shown()).toEqual(['Responder siempre en español']);
  });

  it('desde el turno: la línea dice /olvida 1 y no queda la copia vieja', () => {
    memory.remember(read[1] as string, 'Sin emojis en las respuestas', { tags: ['aprendido'] });
    const r = learnFromTurn({
      memory,
      scope: write,
      reply: 'Vale.\n[[aprendido: Sin emojis en las respuestas]]',
      hinted: true,
      tainted: false,
      forgetScopes: read,
    });
    expect(r.line).toBe('📝 Aprendido: Sin emojis en las respuestas (/olvida 1 para borrarla)');
    expect(shown()).toEqual(['Sin emojis en las respuestas']);
  });

  it('sin ámbitos de lectura todo sigue como antes: solo mira el suyo', () => {
    memory.remember('telegram:dm:222#main', 'Sin emojis', { tags: ['aprendido'] });
    saveLearnedRule(memory, write, 'Sin emojis');
    expect(learnedRules(memory, ['telegram:dm:222#main'])).toHaveLength(1);
  });
});
