import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { learnedRules, saveLearnedRule } from '../src/memory/learned-rules.js';
import { MemoryStore, memoryFile, parseMemory, serializeMemory } from '../src/memory.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const chat = 'telegram:1';
const hilo = 'telegram:1:hilo:7';
const read = [hilo, chat];
let dir = '';
let m: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-learn-hora-'));
  m = new MemoryStore(dir);
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const texts = (): string[] => learnedRules(m, read).map((e) => e.text);

describe('reglas del mismo día en chat e hilo: manda la hora', () => {
  it('la del chat guardada después sale primero aunque el hilo vaya antes', () => {
    vi.setSystemTime(new Date('2026-10-31T09:00:00Z'));
    saveLearnedRule(m, hilo, 'Respuestas cortas', null, read);
    vi.setSystemTime(new Date('2026-10-31T10:00:00Z'));
    saveLearnedRule(m, chat, 'Háblame de tú', null, read);
    expect(texts()).toEqual(['Háblame de tú', 'Respuestas cortas']);
  });

  it('el tope olvida la de verdad más vieja, no la más nueva del chat', () => {
    vi.setSystemTime(new Date('2026-10-31T08:00:00Z'));
    saveLearnedRule(m, chat, 'Recuerda el detalle 0 de la lista', null, read);
    for (let i = 1; i <= 29; i++) {
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 31, 9, i)));
      saveLearnedRule(m, hilo, `Recuerda el detalle ${i} de la lista`, null, read);
    }
    vi.setSystemTime(new Date('2026-10-31T11:00:00Z'));
    saveLearnedRule(m, chat, 'Háblame de tú siempre', null, read);
    const all = texts();
    expect(all).toHaveLength(30);
    expect(all[0]).toBe('Háblame de tú siempre');
    expect(all).not.toContain('Recuerda el detalle 0 de la lista');
  });

  it('la hora va en su propio campo y un fichero viejo sin hora se sigue leyendo', () => {
    vi.setSystemTime(new Date('2026-10-31T09:00:00Z'));
    saveLearnedRule(m, chat, 'Respuestas cortas');
    const file = readFileSync(memoryFile(dir, chat), 'utf8');
    expect(file).toMatch(
      /\(2026-10-31, time: \d{2}:\d{2}:\d{2}, tags: aprendido\) Respuestas cortas/,
    );
    const doc = parseMemory(file);
    expect(doc.entries[0]?.date).toBe('2026-10-31');
    expect(serializeMemory(doc)).toBe(file);
    // Formato viejo: sin hora, cuenta como anterior a las de ese día con hora.
    writeFileSync(
      memoryFile(dir, hilo),
      '# Memory for telegram:1:hilo:7\n\n- [a1] (2026-10-31, tags: aprendido) Sin emojis\n',
    );
    expect(learnedRules(m, read).map((e) => [e.text, e.time])).toEqual([
      ['Respuestas cortas', expect.stringMatching(/^\d{2}:\d{2}:\d{2}$/)],
      ['Sin emojis', undefined],
    ]);
  });
});
