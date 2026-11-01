import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ALTAVOZ_USAGE } from '../src/audio/altavoz.js';
import { MCP_COMMAND_USAGE } from '../src/mcp/tools.js';
import { COMPUTER_SWITCH_USAGE } from '../src/screen/computer-switch.js';
import { formatSkillSearch } from '../src/skills/search.js';
import { parseTriggerAdd } from '../src/triggers.js';

// Nico (1 nov): «conversaciones naturales, no usar cosas como <número o palabra>».
// Avisos, rutinas, disparadores, habilidades, conversación por voz, altavoz,
// /ordenador y /mcp contestaban con «Uso: /cmd <arg> [a|b|c]». Ahora: una pregunta
// normal o las opciones dichas con palabras, siempre con un ejemplo real.
const MARCADOR = /<[a-záéíóúñ][^<>\n]{0,40}>|\bUso:|\b[a-z]+\|[a-z]+\b|\[[a-z]+=/i;
const cli = readFileSync('src/cli.ts', 'utf8');
const store = readFileSync('src/services/store.ts', 'utf8');
const teach = readFileSync('src/teach-demo-web.ts', 'utf8');

describe('respuestas naturales, sin <marcadores> (4): avisos, rutinas, habilidades y modos', () => {
  it('las constantes de ayuda hablan normal', () => {
    for (const t of [ALTAVOZ_USAGE, MCP_COMMAND_USAGE, COMPUTER_SWITCH_USAGE]) {
      expect(t).not.toMatch(MARCADOR);
    }
    expect(COMPUTER_SWITCH_USAGE).toContain('Dime «enciéndelo» o «apágalo»');
  });

  it('/disparador mal escrito: pide lo que falta con dos ejemplos', () => {
    const r = parseTriggerAdd('archivo .pdf');
    expect(r.ok).toBe(false);
    const error = r.ok ? '' : r.error;
    expect(error).not.toMatch(MARCADOR);
    expect(error).toContain('«archivo .pdf | macro/archiva fichero=documentos»');
  });

  it('/skills buscar: el pie no enseña <url>', () => {
    const out = formatSkillSearch('tdd', [
      { name: 'TDD', description: 'Test primero', url: 'https://example.com/SKILL.md' },
    ]);
    expect(out).not.toMatch(MARCADOR);
  });

  it('ya no queda ningún «Uso:» de estos comandos en el chat', () => {
    for (const viejo of [
      'Uso: /ojo',
      'Uso: /ignora ',
      'Uso: /avisos',
      'Uso: /ignorados',
      'Uso: /learn',
      'Uso: /routine',
      'Uso: /disparador',
      'Uso: /skills',
      'Uso: /conversacion',
      '/learn <nombre>',
    ]) {
      expect(cli).not.toContain(viejo);
    }
    expect(teach).not.toContain('Uso: /learn web <https://sitio>');
    expect(store).not.toContain('"estado de <nombre>"');
    expect(cli).toContain("'¿Qué aviso descarto? Dime el número que sale entre corchetes.'");
    expect(cli).toContain("'¿Cómo llamo a la rutina? Dímelo y empiezo a grabar.'");
  });
});
