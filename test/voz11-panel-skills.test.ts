import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { forgetLearnedRule } from '../src/memory/learned-rules.js';
import { formatSkillSearch, skillPickAnswer } from '../src/skills/search.js';

// Nico (1 nov): que Asistenta hable como un amigo, sin mandarle a comandos.
const hits = [
  { name: 'TDD', description: 'Test primero', url: 'https://example.com/tdd/SKILL.md' },
  { name: 'Git', description: '', url: 'https://example.com/git/SKILL.md' },
];

describe('panel, reglas aprendidas y skills sin mandar a comandos', () => {
  it('buscar skills pregunta «¿Instalo alguna?» y entiende el número', () => {
    const out = formatSkillSearch('tdd', hits);
    expect(out).not.toContain('/skills');
    expect(out.split('\n').at(-1)).toBe(
      '¿Instalo alguna? Dime su número (la reviso antes de guardarla).',
    );
    expect(skillPickAnswer(hits, 'la 2')).toBe('instalar https://example.com/git/SKILL.md');
    expect(skillPickAnswer(hits, '1')).toBe('instalar https://example.com/tdd/SKILL.md');
    expect(skillPickAnswer(hits, 'instala la 1')).toBe('instalar https://example.com/tdd/SKILL.md');
    expect(skillPickAnswer(hits, 'https://x.test/a/SKILL.md')).toBe(
      'instalar https://x.test/a/SKILL.md',
    );
    expect(skillPickAnswer(hits, '3')).toBeNull();
    expect(skillPickAnswer(hits, 'qué tal')).toBeNull();
  });

  it('la búsqueda en el chat deja apuntada la respuesta', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli).toContain(
      "preguntas.ask(chatKey(inbound), 'skills', { answer: (t) => skillPickAnswer(hits, t) })",
    );
    expect(cli).toContain('if (hits.length) onHits?.(hits);');
  });

  it('una regla que no se puede borrar no manda a /aprendido', () => {
    const rule = {
      id: 'r1',
      text: 'Sin emojis',
      date: '2026-11-01',
      tags: ['aprendido'],
      supersededBy: null,
    };
    const memory = { all: () => [rule], forgetIn: () => false } as unknown as Parameters<
      typeof forgetLearnedRule
    >[0];
    for (const arg of ['1', 'emojis']) {
      const out = forgetLearnedRule(memory, ['chat'], arg);
      expect(out, arg).toBe('No he podido borrarla; puede que ya estuviera borrada.');
    }
  });

  it('el panel no manda a /cron ni a /reintentar', () => {
    const page = readFileSync(new URL('../src/webui/page.ts', import.meta.url), 'utf8');
    const server = readFileSync(new URL('../src/webui/server.ts', import.meta.url), 'utf8');
    expect(page).not.toContain('usa /cron');
    expect(page).toContain(
      'pídemelo en el chat, por ejemplo «cada mañana a las 8 el resumen del día»',
    );
    expect(server).not.toContain('Telegram con /reintentar');
  });
});
