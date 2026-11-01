import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PreguntasPendientes } from '../src/daemon/pregunta-pendiente.js';
import {
  MEMORIA_FORGET_ASK,
  memoriaForgetAnswer,
  OJO_OFF_HINT,
  ojoOffAnswer,
} from '../src/ojo-respuestas.js';

// Nico (1 nov): que Asistenta hable como un amigo, sin mandarle a comandos.
const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');

describe('el ojo encendido y /memoria olvidar sin mandar a comandos', () => {
  it('Descargas y Pantalla encendidas se apagan con «apágalo»', () => {
    expect(OJO_OFF_HINT).toBe('Si quieres que lo apague, dime «apágalo».');
    expect(cli).not.toMatch(/\/ojo (descargas|pantalla) off lo apaga/);
    expect(cli).toContain("if (on) askOjoOff(inbound, 'descargas');");
    expect(cli).toContain("if (getScreenEnabled(memoryDb)) askOjoOff(inbound, 'pantalla');");
    for (const t of ['apágalo', 'Apaga', 'quítalo!', 'desactívalo'])
      expect(ojoOffAnswer(t), t).toBe(true);
    for (const t of ['sí', 'enciéndelo', 'apaga la luz']) expect(ojoOffAnswer(t), t).toBe(false);
    const p = new PreguntasPendientes();
    p.ask('c', 'ojo', { answer: (t) => (ojoOffAnswer(t) ? 'pantalla off' : null) });
    expect(p.consume('c', 'apágalo')).toEqual({ name: 'ojo', args: 'pantalla off' });
  });

  it('/memoria olvidar sin código pregunta cuál y entiende el código solo', () => {
    expect(MEMORIA_FORGET_ASK).not.toMatch(/\/\w/);
    expect(cli).not.toContain('por ejemplo /memoria olvidar a1b2c3');
    expect(cli).toContain(
      "preguntas.ask(chatKey(inbound), 'memoria', { answer: memoriaForgetAnswer });",
    );
    expect(memoriaForgetAnswer('a1b2c3')).toBe('olvidar a1b2c3');
    expect(memoriaForgetAnswer('«[a1b2c3]»')).toBe('olvidar a1b2c3');
    expect(memoriaForgetAnswer('la del dentista')).toBeNull();
    const p = new PreguntasPendientes();
    p.ask('c', 'memoria', { answer: memoriaForgetAnswer });
    expect(p.consume('c', 'a1b2c3')).toEqual({ name: 'memoria', args: 'olvidar a1b2c3' });
  });
});
