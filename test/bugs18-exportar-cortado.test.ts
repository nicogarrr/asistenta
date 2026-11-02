import { describe, expect, it } from 'vitest';
import { fileFallbackText } from '../src/text.js';

// asis-bugs-18: si Telegram no aceptaba el fichero de /memoria exportar (o /perfil
// exportar, o exportar una conversación), se mandaban 3.500 caracteres del JSON
// cortados sin decir que faltaba el resto.
describe('exportar: el texto de reserva dice si va cortado', () => {
  it('un fichero corto va entero, sin aviso', () => {
    expect(fileFallbackText('{"a": 1}')).toBe('No pude enviar el archivo; aquí va:\n{"a": 1}');
  });

  it('un fichero largo dice que va cortado y cuánto falta', () => {
    const text = fileFallbackText('x'.repeat(5000));
    expect(text).toMatch(/cortad/);
    expect(text).toContain('los primeros 3500 de 5000 caracteres');
    expect(text.length).toBeLessThan(4000);
  });

  it('no parte un emoji en el corte', () => {
    const text = fileFallbackText(`${'x'.repeat(3499)}📦${'y'.repeat(100)}`);
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});
