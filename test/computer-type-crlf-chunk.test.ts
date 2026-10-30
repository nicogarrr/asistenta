import { describe, expect, it } from 'vitest';
import { chunkText, SENDKEYS_CHUNK, WindowsScreen } from '../src/screen/windows.js';

/**
 * Un salto de línea de Windows («\r\n», texto copiado de un correo o un fichero)
 * justo en el corte de 200 caracteres se partía en dos trozos: «\r» al final de
 * uno y «\n» al principio del siguiente. Cada uno se convertía en {ENTER} y se
 * pulsaba Enter DOS veces (línea en blanco de más; en un chat, mensaje enviado
 * a medias).
 */
function screen() {
  const sent: string[] = [];
  const s = new WindowsScreen(async (script) => {
    const m = /SendWait\('([\s\S]*)'\)/.exec(script);
    if (m) sent.push(m[1] ?? '');
    return { stdout: '', stderr: '' };
  });
  return { s, sent };
}

const enters = (xs: string[]) => xs.join('').split('{ENTER}').length - 1;

describe('computer · «\\r\\n» en el corte de un texto largo', () => {
  it('un \\r\\n justo en el corte se escribe como UN solo Enter', async () => {
    const text = `${'a'.repeat(SENDKEYS_CHUNK - 1)}\r\n${'b'.repeat(10)}`;
    const { s, sent } = screen();
    await s.type(text);
    expect(enters(sent)).toBe(1);
    expect(sent.join('')).toBe(`${'a'.repeat(SENDKEYS_CHUNK - 1)}{ENTER}${'b'.repeat(10)}`);
  });

  it('chunkText nunca deja un trozo acabado en \\r si el siguiente empieza por \\n', () => {
    for (let pad = 0; pad < 5; pad++) {
      const text = `${'x'.repeat(SENDKEYS_CHUNK - 1 + pad)}\r\n`.repeat(4);
      const pieces = chunkText(text, SENDKEYS_CHUNK);
      expect(pieces.join('')).toBe(text);
      for (let i = 0; i + 1 < pieces.length; i++) {
        expect(pieces[i]?.endsWith('\r') && pieces[i + 1]?.startsWith('\n')).toBe(false);
      }
      for (const p of pieces) expect(Array.from(p).length).toBeLessThanOrEqual(SENDKEYS_CHUNK);
    }
  });

  it('varias líneas CRLF largas: tantos Enter como saltos de línea', async () => {
    const line = 'y'.repeat(SENDKEYS_CHUNK - 1);
    const text = [line, line, line, 'fin'].join('\r\n');
    const { s, sent } = screen();
    await s.type(text);
    expect(enters(sent)).toBe(3);
  });

  it('sin \\r en el corte, los trozos son los de siempre (caracterización)', () => {
    const text = 'abcdefghij'.repeat(45);
    expect(chunkText(text, SENDKEYS_CHUNK).map((p) => p.length)).toEqual([200, 200, 50]);
    expect(chunkText('a\r\nb', 2)).toEqual(['a', '\r\n', 'b']);
  });
});
