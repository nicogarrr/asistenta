import { describe, expect, it } from 'vitest';
import { releaseLeftButtonScript, WindowsScreen } from '../src/screen/windows.js';

/**
 * drag pulsaba el botón izquierdo ANTES del bucle de movimiento y lo soltaba al
 * final: si SetCursorPos fallaba a mitad (o PowerShell se cortaba), el botón se
 * quedaba pulsado en el PC de Nico y cada movimiento posterior arrastraba cosas.
 * Ningún test mueve el ratón real: se lee el script de PowerShell que se generaría.
 */
function scriptsOf(fail = false): { screen: WindowsScreen; scripts: string[] } {
  const scripts: string[] = [];
  const screen = new WindowsScreen(async (script) => {
    scripts.push(script);
    if (fail && scripts.length === 1) throw new Error('powershell cortado');
    return { stdout: '', stderr: '' };
  });
  return { screen, scripts };
}

describe('WindowsScreen.drag · el botón izquierdo nunca se queda pulsado', () => {
  it('el left-up está en un finally que cubre todo el movimiento', async () => {
    const { screen, scripts } = scriptsOf();
    await screen.drag(10, 20, 300, 400);
    const s = scripts[0] ?? '';
    const down = s.indexOf('mouse_event(0x0002');
    const tryAt = s.indexOf('try {', down);
    const loop = s.indexOf('for ($i=1', down);
    const fin = s.indexOf('} finally {', loop);
    const up = s.indexOf('mouse_event(0x0004', fin);
    expect(down).toBeGreaterThan(-1);
    expect(tryAt).toBeGreaterThan(down);
    expect(loop).toBeGreaterThan(tryAt);
    expect(fin).toBeGreaterThan(loop);
    expect(up).toBeGreaterThan(fin);
    expect([...s.matchAll(/mouse_event\(0x0004/g)].length).toBe(1);
  });

  it('si PowerShell falla, se manda una liberación aparte y el error sigue llegando', async () => {
    const { screen, scripts } = scriptsOf(true);
    await expect(screen.drag(10, 20, 300, 400)).rejects.toThrow(/powershell cortado/);
    expect(scripts.length).toBe(2);
    expect(scripts[1]).toBe(releaseLeftButtonScript());
  });

  it('la liberación solo suelta el botón si Windows lo ve pulsado', () => {
    const s = releaseLeftButtonScript();
    expect(s).toMatch(
      /if \(\(\[L\]::GetAsyncKeyState\(0x01\) -band 0x8000\) -ne 0\) \{ \[L\]::mouse_event\(0x0004/,
    );
    expect(s).not.toMatch(/0x0002/);
  });

  it('un drag que va bien no manda nada más (caracterización)', async () => {
    const { screen, scripts } = scriptsOf();
    await screen.drag(1, 2, 3, 4);
    expect(scripts.length).toBe(1);
  });
});
