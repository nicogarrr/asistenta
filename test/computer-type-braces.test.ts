import { describe, expect, it } from 'vitest';
import { splitAsciiSegments } from '../src/screen/keys.js';
import { WindowsScreen } from '../src/screen/windows.js';

/**
 * Llaves en el texto que escribe Computer Use. SendKeys interpreta `{...}` como el
 * nombre de una tecla: antes, escribir `{"a":1}` fallaba («tecla no válida») y un
 * texto como `{ENTER}` o `{DEL 50}` se PULSABA en vez de escribirse. Ahora las
 * llaves van por el camino de pegar (portapapeles), como los emojis.
 */
describe('computer · llaves literales al escribir', () => {
  it('las llaves salen del tramo de SendKeys', () => {
    expect(splitAsciiSegments('a{b}c')).toEqual([
      { kind: 'ascii', text: 'a' },
      { kind: 'unicode', text: '{' },
      { kind: 'ascii', text: 'b' },
      { kind: 'unicode', text: '}' },
      { kind: 'ascii', text: 'c' },
    ]);
  });

  it('sin llaves, el reparto es el de siempre', () => {
    expect(splitAsciiSegments('Hola (1+1)')).toEqual([{ kind: 'ascii', text: 'Hola (1+1)' }]);
    expect(splitAsciiSegments('ok ❤')).toEqual([
      { kind: 'ascii', text: 'ok ' },
      { kind: 'unicode', text: '❤' },
    ]);
  });

  it('«{ENTER}» se escribe tal cual: ningún SendWait recibe una llave', async () => {
    const scripts: string[] = [];
    const screen = new WindowsScreen(async (script) => {
      scripts.push(script);
      return { stdout: '', stderr: '' };
    });
    await screen.type('{ENTER}{DEL 50}');
    const sendWaits = scripts
      .map((s) => /SendWait\('((?:[^']|'')*)'\)/.exec(s)?.[1])
      .filter((x): x is string => x !== undefined && x !== '^v');
    expect(sendWaits.join('|')).not.toMatch(/[{}]/);
    expect(sendWaits).toEqual(['ENTER', 'DEL 50']);
    const pasted = scripts
      .map((s) => /FromBase64String\('([^']+)'\)/.exec(s)?.[1])
      .filter((x): x is string => !!x)
      .map((b) => Buffer.from(b, 'base64').toString('utf8'));
    expect(pasted.join('')).toBe('{}{}');
  });

  it('JSON: el texto completo llega en orden', async () => {
    const parts: string[] = [];
    const screen = new WindowsScreen(async (script) => {
      const sw = /SendWait\('((?:[^']|'')*)'\)/.exec(script)?.[1];
      const b64 = /FromBase64String\('([^']+)'\)/.exec(script)?.[1];
      if (b64) parts.push(Buffer.from(b64, 'base64').toString('utf8'));
      else if (sw !== undefined) parts.push(sw.replace(/''/g, "'"));
      return { stdout: '', stderr: '' };
    });
    await screen.type('{"a":1}');
    expect(parts.join('')).toBe('{"a":1}');
  });
});
