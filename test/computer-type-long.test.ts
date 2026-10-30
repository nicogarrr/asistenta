import { describe, expect, it } from 'vitest';
import { chunkText, SENDKEYS_CHUNK, WindowsScreen } from '../src/screen/windows.js';

/**
 * Textos largos al escribir. Antes un correo entero iba en UN SendWait: en una
 * app lenta pasaba de los 30 s de PowerShell, se cortaba a medias y el modelo,
 * que solo sabía «falló», volvía a escribir TODO (texto duplicado). Ahora va en
 * trozos de 200 y, si falla a medias, el error dice cuánto se escribió ya.
 */
function screen(failAt?: number) {
  const sent: string[] = [];
  let n = 0;
  const s = new WindowsScreen(async (script) => {
    n++;
    if (n === failAt) throw new Error('PowerShell no respondió en 30 s y se cortó');
    const m = /SendWait\('([\s\S]*)'\)/.exec(script);
    if (m) sent.push(m[1] ?? '');
    return { stdout: '', stderr: '' };
  });
  return { s, sent };
}

describe('computer · escribir textos largos', () => {
  it('un texto corto sigue yendo en una sola llamada (caracterización)', async () => {
    const { s, sent } = screen();
    await s.type('Hola Nico, ¿qué tal?'.replace('¿', '').replace('é', 'e'));
    expect(sent).toEqual(['Hola Nico, que tal?']);
  });

  it('un texto de 450 caracteres va en 3 trozos que juntos son el texto exacto', async () => {
    const text = 'abcdefghij'.repeat(45);
    const { s, sent } = screen();
    await s.type(text);
    expect(sent.map((x) => x.length)).toEqual([200, 200, 50]);
    expect(sent.join('')).toBe(text);
  });

  it('si falla a medias, el error dice cuántos caracteres ya se escribieron', async () => {
    const { s } = screen(2);
    await expect(s.type('x'.repeat(450))).rejects.toThrow(/200 of 450[\s\S]*do not retype/);
  });

  it('si falla el primer trozo, el error es el mismo de siempre', async () => {
    const { s } = screen(1);
    await expect(s.type('x'.repeat(450))).rejects.toThrow(
      /^PowerShell no respondió en 30 s y se cortó$/,
    );
  });

  it('chunkText no parte un emoji', () => {
    const parts = chunkText('😀'.repeat(5), 2);
    expect(parts).toEqual(['😀😀', '😀😀', '😀']);
    expect(chunkText('abc', SENDKEYS_CHUNK)).toEqual(['abc']);
  });
});
