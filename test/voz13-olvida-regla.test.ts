import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { forgetRuleHint, forgetRuleWords } from '../src/memory/learned-rules.js';

// Nico (1 nov): que Asistenta hable como un amigo, sin mandarle a «/olvida N».
const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
const rules = readFileSync(new URL('../src/memory/learned-rules.ts', import.meta.url), 'utf8');

describe('una regla aprendida se borra diciendo «olvida la regla N»', () => {
  it('la línea «📝 Aprendido» no nombra el comando', () => {
    expect(forgetRuleHint(2)).toBe('si no la quieres, dime «olvida la regla 2»');
    expect(forgetRuleHint(2)).not.toMatch(/\/\w/);
    expect(rules).not.toContain('para borrarla)');
  });

  it('entiende «olvida la regla 2» y parecidos; nada más', () => {
    for (const t of [
      'olvida la regla 2',
      'Olvída la regla 2.',
      'borra la regla 12',
      'quita la regla 3!',
    ])
      expect(forgetRuleWords(t), t).toMatch(/^\d+$/);
    expect(forgetRuleWords('olvida la regla 2')).toBe('2');
    for (const t of [
      'olvida lo de la regla',
      'olvida la 2',
      'la regla 2',
      'olvida la regla dos',
      '',
    ])
      expect(forgetRuleWords(t), t).toBeNull();
  });

  it('funciona en Telegram y en el panel como /olvida', () => {
    expect(cli).toContain('if (await forgetRuleByWords(inbound)) return;');
    expect(rules).toContain('const byWords = forgetRuleWords(text);');
  });
});
