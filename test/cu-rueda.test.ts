import { describe, expect, it, vi } from 'vitest';

/**
 * Rueda del ratón en Computer Use: listas largas, Configuración, páginas, sin tener que
 * arrastrar barras ni depender del foco del teclado. Pregunta igual que un clic.
 */

vi.mock('../src/screen/verify.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/screen/verify.js')>();
  return { ...real, compareFrames: vi.fn() };
});

import { formatApproval } from '../src/approval-text.js';
import type { Config } from '../src/config.js';
import { Gate } from '../src/permissions.js';
import { parseMap, shareMap } from '../src/screen/ui-map.js';
import type { Screenshot } from '../src/screen/verify.js';
import { WHEEL_MAX_NOTCHES, WindowsScreen } from '../src/screen/windows.js';
import { createComputerTool, type ScreenBackend } from '../src/tools/computer.js';

const cfg = {
  screenshotMaxEdge: 1280,
  screenshotQuality: 80,
  verifyActions: false,
  verifySettleMs: 1,
} as Config;

function fake(withScroll = true) {
  const calls: string[] = [];
  const backend: ScreenBackend = {
    screenshot: async (): Promise<Screenshot> => ({
      image: Buffer.from('f'),
      mimeType: 'image/jpeg',
      width: 1280,
      height: 720,
      nativeWidth: 1920,
      nativeHeight: 1080,
    }),
    click: async () => {},
    move: async () => {},
    drag: async () => {},
    type: async () => {},
    key: async () => {},
    screenSize: async () => ({ width: 1920, height: 1080 }),
    uiMap: async (id) =>
      parseMap(
        'UIMAP {"w":"Configuración","c":1,"i":[{"t":"ListItem","n":"Bluetooth","l":100,"o":200,"w":300,"h":40,"e":true,"f":false}]}',
        id,
      ),
    elementLookup: async () => ({ state: 'ok', x: 250, y: 220 }),
  };
  if (withScroll) {
    backend.scroll = async (x, y, n) => {
      calls.push(`scroll:${x},${y}:${n}`);
    };
  }
  return { backend, calls };
}

describe('WindowsScreen.scroll', () => {
  it('coloca el cursor y manda muescas de rueda (positivo baja, negativo sube)', async () => {
    const scripts: string[] = [];
    const screen = new WindowsScreen(async (s) => {
      scripts.push(s);
      return { stdout: '', stderr: '' };
    });
    await screen.scroll(10, 20, 2);
    await screen.scroll(10, 20, -1);
    expect(scripts[0]).toContain('[PaDesktop]::SetCursorPos(10, 20)');
    expect(scripts[0]?.match(/mouse_event\(0x0800,0,0,\[uint32\]4294967176/g)).toHaveLength(2);
    expect(scripts[1]?.match(/mouse_event\(0x0800,0,0,\[uint32\]120,/g)).toHaveLength(1);
  });

  it('acota las muescas y no hace nada con 0', async () => {
    const scripts: string[] = [];
    const screen = new WindowsScreen(async (s) => {
      scripts.push(s);
      return { stdout: '', stderr: '' };
    });
    await screen.scroll(1, 1, 0);
    expect(scripts).toHaveLength(0);
    await screen.scroll(1, 1, 999);
    expect(scripts[0]?.match(/0x0800/g)).toHaveLength(WHEEL_MAX_NOTCHES);
  });
});

describe('computer action=scroll', () => {
  it('x/y de la captura pasan a píxeles reales; por defecto 3 hacia abajo', async () => {
    const f = fake();
    const tool = createComputerTool(cfg, f.backend);
    await tool.execute('1', { action: 'screenshot' });
    const out = await tool.execute('2', { action: 'scroll', x: 640, y: 360 });
    expect(f.calls).toEqual(['scroll:960,540:3']);
    expect(JSON.stringify(out.content)).toContain('Rueda abajo 3 en 960,540');
  });

  it('sobre un elemento del mapa y hacia arriba', async () => {
    const f = fake();
    const tool = createComputerTool(cfg, f.backend);
    await tool.execute('1', { action: 'screenshot', map: true });
    const out = await tool.execute('2', { action: 'scroll', element: 1, amount: -5 });
    expect(f.calls).toEqual(['scroll:250,220:-5']);
    expect(JSON.stringify(out.content)).toContain(
      'Rueda arriba 5 sobre el elemento 1 (Elemento «Bluetooth»)',
    );
  });

  it('amount inválido, roi o sin rueda: error claro y no se mueve nada', async () => {
    const f = fake();
    const tool = createComputerTool(cfg, f.backend);
    await expect(tool.execute('1', { action: 'scroll', x: 1, y: 1, amount: 0 })).rejects.toThrow(
      /entre -25 y 25/,
    );
    await expect(tool.execute('2', { action: 'scroll', x: 1, y: 1, amount: 30 })).rejects.toThrow(
      /entre -25 y 25/,
    );
    await expect(tool.execute('3', { action: 'scroll', x: 1, y: 1, amount: 1.5 })).rejects.toThrow(
      /entre -25 y 25/,
    );
    await expect(
      tool.execute('4', { action: 'scroll', x: 1, y: 1, roi: { x: 0, y: 0, width: 5, height: 5 } }),
    ).rejects.toThrow(/roi solo vale/);
    expect(f.calls).toEqual([]);
    const none = fake(false);
    const tool2 = createComputerTool(cfg, none.backend);
    await expect(tool2.execute('5', { action: 'scroll', x: 1, y: 1 })).rejects.toThrow(
      /rueda del ratón no está disponible/,
    );
  });
});

describe('permisos de la rueda', () => {
  it('pregunta como un clic y no se puede dar «siempre»', async () => {
    const asked: string[] = [];
    const gate = new Gate({
      protectedPaths: [],
      approver: (call) => {
        asked.push(String(call.args.action));
        return false;
      },
    });
    const d = await gate.check('s', {
      tool: 'computer',
      args: { action: 'scroll', x: 5, y: 5 },
      actor: 'me',
    });
    expect(d.verdict).not.toBe('allow');
    expect(asked).toEqual(['scroll']);
  });

  it('la pregunta dice hacia dónde y dónde', () => {
    shareMap(
      parseMap(
        'UIMAP {"w":"X","c":1,"i":[{"t":"ListItem","n":"Bluetooth","l":1,"o":1,"w":4,"h":4}]}',
        'm',
      ),
    );
    expect(
      formatApproval(
        { tool: 'computer', args: { action: 'scroll', x: 5, y: 6, amount: -2 }, actor: 'me' },
        'x',
      ).question,
    ).toContain('rueda del ratón arriba 2 en (5, 6)');
    expect(
      formatApproval({ tool: 'computer', args: { action: 'scroll', element: 1 }, actor: 'me' }, 'x')
        .question,
    ).toContain('rueda del ratón abajo 3 en el elemento 1 del mapa (Elemento «Bluetooth»)');
    shareMap(null);
  });
});
