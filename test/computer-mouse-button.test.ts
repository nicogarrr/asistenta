import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { mouseButtonFlags, WindowsScreen } from '../src/screen/windows.js';
import { type ActionGate, createComputerTool, type ScreenBackend } from '../src/tools/computer.js';

/**
 * Botón del ratón: un nombre desconocido («double», «Left», «primary»…) mandaba en
 * Windows un «izquierdo abajo» seguido de un «central arriba»: el botón izquierdo
 * se quedaba pulsado y cada movimiento posterior arrastraba. Ningún test mueve el
 * ratón real: se lee el script de PowerShell que se generaría.
 */

function scriptsOf(): { screen: WindowsScreen; scripts: string[] } {
  const scripts: string[] = [];
  const screen = new WindowsScreen(async (script) => {
    scripts.push(script);
    return { stdout: '', stderr: '' };
  });
  return { screen, scripts };
}

function events(script: string): string[] {
  return [...script.matchAll(/mouse_event\((0x[0-9A-Fa-f]+)/g)].map((m) => m[1] ?? '');
}

describe('WindowsScreen.click · pares abajo/arriba', () => {
  it.each([
    ['left', ['0x0002', '0x0004']],
    ['right', ['0x0008', '0x0010']],
    ['middle', ['0x0020', '0x0040']],
    ['Left', ['0x0002', '0x0004']],
    [' RIGHT ', ['0x0008', '0x0010']],
  ])('%s suelta el mismo botón que pulsa', async (button, pair) => {
    const { screen, scripts } = scriptsOf();
    await screen.click(10, 20, { button, clicks: 2 });
    expect(events(scripts[0] ?? '')).toEqual([...pair, ...pair]);
  });

  it('un botón desconocido no genera ningún evento', async () => {
    const { screen, scripts } = scriptsOf();
    await expect(screen.click(10, 20, { button: 'double' })).rejects.toThrow(/desconocido/);
    expect(scripts).toEqual([]);
    expect(() => mouseButtonFlags('primary')).toThrow();
  });

  it('clics no numéricos hacen un clic, no cero', async () => {
    const { screen, scripts } = scriptsOf();
    await screen.click(1, 1, { clicks: Number.NaN });
    expect(events(scripts[0] ?? '')).toEqual(['0x0002', '0x0004']);
  });
});

describe('computer · validación de botón y clics', () => {
  const calls: string[] = [];
  const backend: ScreenBackend = {
    screenshot: async () => {
      throw new Error('no se usa');
    },
    click: async (x, y, o) => {
      calls.push(`click:${x},${y}:${o?.button}:${o?.clicks}`);
    },
    move: async () => {},
    drag: async () => {},
    type: async () => {},
    key: async () => {},
    screenSize: async () => ({ width: 100, height: 100 }),
  };
  const allow: ActionGate = () => ({ verdict: 'allow', reason: '' });
  const tool = createComputerTool({ verifyActions: false } as Config, backend, allow);

  it('normaliza mayúsculas y por defecto es izquierdo, un clic', async () => {
    calls.length = 0;
    await tool.execute('a', { action: 'click', x: 1, y: 1, button: 'Right' });
    await tool.execute('b', { action: 'click', x: 1, y: 1 });
    expect(calls).toEqual(['click:1,1:right:1', 'click:1,1:left:1']);
  });

  it('rechaza un botón o un número de clics inválido antes de tocar el ratón', async () => {
    calls.length = 0;
    await expect(
      tool.execute('a', { action: 'click', x: 1, y: 1, button: 'double' }),
    ).rejects.toThrow(/left, right o middle/);
    await expect(tool.execute('b', { action: 'click', x: 1, y: 1, clicks: 0 })).rejects.toThrow(
      /clicks/,
    );
    await expect(tool.execute('c', { action: 'click', x: 1, y: 1, clicks: 1.5 })).rejects.toThrow(
      /clicks/,
    );
    await expect(tool.execute('d', { action: 'click', x: 1, y: 1, clicks: 50 })).rejects.toThrow(
      /clicks/,
    );
    expect(calls).toEqual([]);
  });
});
