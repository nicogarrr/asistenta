import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  forgetLearnedRule,
  formatLearnedRules,
  learnedRules,
  MAX_LEARNED_RULES,
  saveLearnedRule,
} from '../src/memory/learned-rules.js';
import { MemoryStore } from '../src/memory.js';

// El tope de 30 se contaba solo en el ámbito donde se guardaba, pero /aprendido junta
// varios (hilo + chat): salían más de 30, «… y N más» no se podían ver ni /olvidar,
// y todas seguían entrando en cada turno.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('tope de reglas aprendidas con varios ámbitos', () => {
  it('lo que enseña /aprendido nunca pasa del tope', () => {
    const d = mkdtempSync(join(tmpdir(), 'pa-tope-ambitos-'));
    dirs.push(d);
    const m = new MemoryStore(d);
    const chat = 'telegram:1';
    const hilo = 'telegram:1:hilo:7';
    const read = [hilo, chat];
    for (let i = 1; i <= 20; i++) {
      expect(saveLearnedRule(m, chat, `Recuerda el detalle ${i} de la lista`).status).toBe('saved');
    }
    for (let i = 21; i <= 40; i++) {
      expect(
        saveLearnedRule(m, hilo, `Recuerda el detalle ${i} de la lista`, null, read).status,
      ).toBe('saved');
    }
    const rules = learnedRules(m, read);
    expect(rules.length).toBe(MAX_LEARNED_RULES);
    expect(rules[0]?.text).toBe('Recuerda el detalle 40 de la lista');
    expect(rules[rules.length - 1]?.text).toBe('Recuerda el detalle 11 de la lista');
    expect(formatLearnedRules(rules)).not.toContain('más.');
    // La última que se ve se puede borrar.
    expect(forgetLearnedRule(m, read, String(MAX_LEARNED_RULES))).toContain('Olvidada');
  });

  it('de días distintos, la más reciente primero aunque esté en el otro ámbito', () => {
    const d = mkdtempSync(join(tmpdir(), 'pa-orden-ambitos-'));
    dirs.push(d);
    const m = new MemoryStore(d);
    m.remember('a', 'Regla vieja del primero', { tags: ['aprendido'] });
    m.remember('b', 'Regla nueva del segundo', { tags: ['aprendido'] });
    const viejo = m.all('a')[0];
    if (viejo) viejo.date = '2026-01-01';
    const fake = {
      all: (s: string) => (s === 'a' && viejo ? [viejo] : m.all(s)),
    } as unknown as MemoryStore;
    expect(learnedRules(fake, ['a', 'b']).map((r) => r.text)).toEqual([
      'Regla nueva del segundo',
      'Regla vieja del primero',
    ]);
  });
});
