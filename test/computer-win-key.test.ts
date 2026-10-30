import { describe, expect, it } from 'vitest';
import { parseKeyChord, winChordVirtualKeys } from '../src/screen/keys.js';
import { WindowsScreen, winChordScript } from '../src/screen/windows.js';

/**
 * Tecla Windows: SendKeys no tiene modificador para ella y `#` es un carácter
 * normal, así que «win+r» escribía «#r» en la ventana activa. Ahora esos acordes
 * van como pulsaciones reales (keybd_event), soltadas siempre en un finally.
 * Ningún test pulsa teclas reales: se lee el script que se generaría.
 */

function rig() {
  const scripts: string[] = [];
  const screen = new WindowsScreen(async (script) => {
    scripts.push(script);
    return { stdout: '', stderr: '' };
  });
  return { screen, scripts };
}

describe('acordes con la tecla Windows', () => {
  it('parseKeyChord ya no devuelve «#…» que SendKeys teclearía como texto', () => {
    expect(() => parseKeyChord('win+r')).toThrow(/Windows key/);
    expect(() => parseKeyChord('ctrl+cmd+d')).toThrow(/Windows key/);
    // El resto de acordes no cambia.
    expect(parseKeyChord('ctrl+shift+esc')).toBe('^+{ESC}');
  });

  it('códigos virtuales en orden de pulsación', () => {
    expect(winChordVirtualKeys('win+r')).toEqual([0x5b, 0x52]);
    expect(winChordVirtualKeys('Win+Shift+S')).toEqual([0x5b, 0x10, 0x53]);
    expect(winChordVirtualKeys('win')).toEqual([0x5b]);
    expect(winChordVirtualKeys('win+d')).toEqual([0x5b, 0x44]);
    expect(winChordVirtualKeys('win+left')).toEqual([0x5b, 0x25]);
    expect(winChordVirtualKeys('win+1')).toEqual([0x5b, 0x31]);
    expect(winChordVirtualKeys('win+.')).toEqual([0x5b, 0xbe]);
    expect(winChordVirtualKeys('win+f12')).toEqual([0x5b, 0x7b]);
    expect(winChordVirtualKeys('ctrl+s')).toBeNull();
    expect(winChordVirtualKeys('enter')).toBeNull();
  });

  it('rechaza teclas sin código fijo en lugar de adivinar', () => {
    expect(() => winChordVirtualKeys('win+ñ')).toThrow(/unrecognised key/);
    expect(() => winChordVirtualKeys('win+hyper+r')).toThrow(/unknown modifier/);
  });

  it('el script pulsa en orden y suelta en orden inverso dentro de finally', () => {
    const s = winChordScript([0x5b, 0x10, 0x53]);
    const downs = [...s.matchAll(/keybd_event\((0x[0-9a-f]+),0,0,/g)].map((m) => m[1]);
    const ups = [...s.matchAll(/keybd_event\((0x[0-9a-f]+),0,2,/g)].map((m) => m[1]);
    expect(downs).toEqual(['0x5b', '0x10', '0x53']);
    expect(ups).toEqual(['0x53', '0x10', '0x5b']);
    expect(s.indexOf('finally')).toBeLessThan(s.indexOf('keybd_event(0x53,0,2'));
    expect(s).not.toContain('SendWait');
  });

  it('WindowsScreen.key usa eventos reales para win+… y SendKeys para lo demás', async () => {
    const { screen, scripts } = rig();
    await screen.key('win+r');
    await screen.key('ctrl+s');
    expect(scripts[0]).toContain('keybd_event(0x5b,0,0');
    expect(scripts[0]).not.toContain("SendWait('#");
    expect(scripts[1]).toContain("SendWait('^s')");
  });
});
