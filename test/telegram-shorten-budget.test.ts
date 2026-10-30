import { describe, expect, it } from 'vitest';
import { shorten, telegramHtml } from '../src/channels/formatters.js';

describe('shorten: presupuesto de la respuesta en Telegram', () => {
  it('una lista corta que apenas pasa de 300 caracteres llega entera', () => {
    const list = Array.from(
      { length: 7 },
      (_, i) => `• Opción ${i + 1}: algo breve de cuarenta letras aprox`,
    ).join('\n');
    expect(list.length).toBeGreaterThan(300);
    expect(shorten(list)).toEqual({ text: list, truncated: false });
  });

  it('la prosa larga se sigue recortando y el aviso nombra el botón', () => {
    const long = 'Frase de relleno bastante normal. '.repeat(20);
    const out = shorten(long);
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(300);
    expect(out.text.endsWith('…\nPulsa «📖 Ver todo» o dime «más».')).toBe(true);
  });

  it('una negrita partida por el corte se cierra y sigue en negrita', () => {
    const text = `${'Hola. '.repeat(40)}**esta negrita cruza justo el límite de trescientos caracteres** y sigue más texto aquí para que se recorte del todo.${' Más.'.repeat(30)}`;
    const out = shorten(text);
    expect(out.truncated).toBe(true);
    expect((out.text.match(/\*\*/g) ?? []).length % 2).toBe(0);
    expect(telegramHtml(out.text)).toMatch(/<b>esta negrita[^<]*<\/b>…/);
  });
});
