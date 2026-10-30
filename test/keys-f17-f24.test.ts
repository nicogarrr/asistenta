import { describe, expect, it } from 'vitest';
import {
  highFunctionKeyVirtualKeys,
  knownKeyNames,
  parseKeyChord,
  winChordVirtualKeys,
} from '../src/screen/keys.js';
import { WindowsScreen } from '../src/screen/windows.js';

/**
 * F17–F24: SendKeys no las conoce, así que se rechazaban. Ahora van como
 * pulsaciones reales (como los atajos con la tecla Windows). Todas las demás
 * teclas siguen saliendo por SendKeys igual que antes. Nada pulsa teclas reales:
 * PowerShell es falso.
 */
function runner() {
  const calls: string[] = [];
  const run = async (script: string) => {
    calls.push(script);
    return { stdout: '', stderr: '' };
  };
  return { calls, run };
}

describe('F17–F24 como pulsaciones reales', () => {
  it('f17 y ctrl+shift+f24 salen como keybd_event, no por SendKeys', async () => {
    const r = runner();
    await new WindowsScreen(r.run).key('f17');
    await new WindowsScreen(r.run).key('ctrl+shift+F24');
    expect(r.calls).toHaveLength(2);
    expect(r.calls[0]).toContain('keybd_event(0x80,0,0');
    expect(r.calls[0]).not.toContain('SendWait');
    expect(r.calls[1]).toContain('keybd_event(0x11,0,0');
    expect(r.calls[1]).toContain('keybd_event(0x10,0,0');
    expect(r.calls[1]).toContain('keybd_event(0x87,0,0');
    expect(r.calls[1]).not.toContain('SendWait');
  });

  it('códigos de tecla correctos', () => {
    expect(highFunctionKeyVirtualKeys('f17')).toEqual([0x80]);
    expect(highFunctionKeyVirtualKeys('alt+f20')).toEqual([0x12, 0x83]);
    expect(highFunctionKeyVirtualKeys('ctrl + F24')).toEqual([0x11, 0x87]);
    expect(() => highFunctionKeyVirtualKeys('hyper+f17')).toThrow(/unknown modifier/);
  });

  it('el resto de teclas no cambia de camino: siguen por SendKeys', async () => {
    const chords = [
      ...knownKeyNames(),
      'ctrl+c',
      'alt+f4',
      'shift+f16',
      'ctrl+shift+esc',
      'f1',
      'f16',
      'a',
    ];
    for (const k of chords) {
      expect(highFunctionKeyVirtualKeys(k), k).toBeNull();
      if (winChordVirtualKeys(k)) continue;
      const r = runner();
      await new WindowsScreen(r.run).key(k);
      expect(r.calls[0], k).toContain(`SendWait('${parseKeyChord(k).replace(/'/g, "''")}')`);
    }
  });

  it('con la tecla Windows sigue el camino de siempre y f25 se sigue rechazando', async () => {
    expect(winChordVirtualKeys('win+f17')).toEqual([0x5b, 0x80]);
    expect(highFunctionKeyVirtualKeys('f25')).toBeNull();
    await expect(new WindowsScreen(runner().run).key('f25')).rejects.toThrow(/unrecognised key/);
  });
});
