import { describe, expect, it } from 'vitest';
import { WindowsScreen } from '../src/screen/windows.js';

/**
 * Escribir que falla a medias suelta las teclas modificadoras. Un SendKeys
 * cortado por el límite de 30 s (mayúsculas y símbolos van con Shift) o un pegado
 * cortado tras Ctrl+V puede dejar Shift o Ctrl pulsados en el PC de Nico, y
 * cada tecla siguiente sale como atajo. key() ya lo hacía (#546); type() no.
 */
const isRelease = (s: string): boolean => s.includes('GetAsyncKeyState');

function screen(failAt?: number) {
  const scripts: string[] = [];
  let n = 0;
  const s = new WindowsScreen(async (script) => {
    scripts.push(script);
    n++;
    if (n === failAt) throw new Error('PowerShell no respondió en 30 s y se cortó');
    return { stdout: '', stderr: '' };
  });
  return { s, scripts };
}

describe('computer · type() suelta modificadoras si falla', () => {
  it('sin fallo: solo los trozos, ninguna llamada extra (caracterización)', async () => {
    const { s, scripts } = screen();
    await s.type('A'.repeat(450));
    expect(scripts).toHaveLength(3);
    expect(scripts.some(isRelease)).toBe(false);
  });

  it('falla el primer trozo: suelta modificadoras y devuelve el error original', async () => {
    const { s, scripts } = screen(1);
    // El error original va primero; debajo, el aviso de que el corte pudo dejar
    // parte del texto escrita (test/computer-type-long.test.ts).
    await expect(s.type('Hola')).rejects.toThrow(
      /^PowerShell no respondió en 30 s y se cortó\nParcial: puede que se hayan escrito hasta 4 de 4 /,
    );
    expect(scripts).toHaveLength(2);
    expect(isRelease(scripts[1] ?? '')).toBe(true);
  });

  it('falla a medias: suelta modificadoras y el error sigue diciendo cuánto se escribió', async () => {
    const { s, scripts } = screen(2);
    await expect(s.type('A'.repeat(450))).rejects.toThrow(/200 de 450/);
    expect(scripts).toHaveLength(3);
    expect(isRelease(scripts[2] ?? '')).toBe(true);
  });

  it('falla un pegado (texto no ASCII): también suelta modificadoras', async () => {
    const { s, scripts } = screen(1);
    await expect(s.type('ñ')).rejects.toThrow();
    expect(isRelease(scripts.at(-1) ?? '')).toBe(true);
  });

  it('si soltar también falla, el error es el original', async () => {
    let n = 0;
    const s = new WindowsScreen(async () => {
      n++;
      throw new Error(n === 1 ? 'original' : 'soltar falló');
    });
    await expect(s.type('Hola')).rejects.toThrow(/^original$/);
  });
});
