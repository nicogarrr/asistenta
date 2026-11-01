import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PreguntasPendientes } from '../src/daemon/pregunta-pendiente.js';
import {
  DOWNLOADS_OFF_TEXT,
  ojoOnAnswer,
  SCREEN_OFF_TEXT,
  WIDE_EXAMPLE,
} from '../src/ojo-respuestas.js';
import { wideResearch } from '../src/research/wide-research.js';

// Nico (1 nov): que Asistenta hable como un amigo, sin mandarle a comandos.
const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');

describe('el ojo y la investigación amplia sin mandar a /ojo ni /investiga', () => {
  it('Descargas y Pantalla apagadas se encienden con «enciéndelo»', () => {
    expect(DOWNLOADS_OFF_TEXT).not.toMatch(/\/\w/);
    expect(SCREEN_OFF_TEXT).not.toMatch(/\/\w/);
    expect(cli).not.toMatch(/\/ojo (descargas|pantalla) on lo enciende/);
    for (const t of ['enciéndelo', 'sí', 'Actívalo!', 'vale']) expect(ojoOnAnswer(t), t).toBe(true);
    for (const t of ['no', 'apágalo', 'qué es esto']) expect(ojoOnAnswer(t), t).toBe(false);
    expect(cli).toMatch(/answer: \(t\) => \(ojoOnAnswer\(t\) \? `\$\{what\} on` : null\)/);
    expect(cli).toContain("if (!on) askOjoOn(inbound, 'descargas');");
    expect(cli).toContain("if (!getScreenEnabled(memoryDb)) askOjoOn(inbound, 'pantalla');");
  });

  it('la investigación amplia pone el ejemplo en palabras y acepta la respuesta', async () => {
    expect(WIDE_EXAMPLE).toBe('«precio y garantía | iPhone 16, Pixel 9, Galaxy S25»');
    expect(cli).not.toContain('Por ejemplo: /investiga amplio');
    await expect(wideResearch('  ', ['a'], {} as never)).rejects.toThrow(
      'Falta la pregunta. Por ejemplo: «precio y garantía | iPhone 16, Pixel 9».',
    );
    const p = new PreguntasPendientes();
    p.ask('c', 'investiga', { prefix: 'amplio ', accepts: (t) => t.includes('|') });
    expect(p.consume('c', 'precio | iPhone 16, Pixel 9')).toEqual({
      name: 'investiga',
      args: 'amplio precio | iPhone 16, Pixel 9',
    });
    expect(cli).toContain("preguntas.ask(chatKey(inbound), 'investiga', {");
  });
});
