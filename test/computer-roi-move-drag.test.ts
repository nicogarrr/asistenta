import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import type { Screenshot } from '../src/screen/verify.js';
import { createComputerTool, type ScreenBackend } from '../src/tools/computer.js';

/**
 * `roi` solo existe para screenshot y click (x/y relativos a la roi). Un move o
 * un drag con roi la ignoraba en silencio y usaba x/y como si fueran de la
 * captura completa: tras una captura de una roi, el modelo arrastraba o movía el
 * ratón en OTRO sitio del PC de Nico. Ahora se rechaza sin tocar nada.
 */
const config = {
  screenshotMaxEdge: 1280,
  screenshotQuality: 80,
  verifyActions: false,
  verifySettleMs: 1,
} as Config;

function backend() {
  const calls: string[] = [];
  const shot = async (): Promise<Screenshot> => ({
    image: Buffer.from('f'),
    mimeType: 'image/jpeg',
    width: 1280,
    height: 720,
    nativeWidth: 1280,
    nativeHeight: 720,
  });
  const b = {
    screenshot: shot,
    screenSize: async () => ({ width: 1280, height: 720 }),
    click: async (x: number, y: number) => {
      calls.push(`click ${x},${y}`);
    },
    move: async (x: number, y: number) => {
      calls.push(`move ${x},${y}`);
    },
    drag: async (x: number, y: number, tx: number, ty: number) => {
      calls.push(`drag ${x},${y}->${tx},${ty}`);
    },
    type: async () => {},
    key: async () => {},
  } as unknown as ScreenBackend;
  return { b, calls };
}

const roi = { x: 600, y: 300, width: 200, height: 100 };

describe('computer · roi en move/drag', () => {
  it('drag con roi se rechaza y no arrastra nada', async () => {
    const { b, calls } = backend();
    const tool = createComputerTool(config, b);
    await expect(
      tool.execute('1', { action: 'drag', x: 10, y: 10, toX: 50, toY: 50, roi } as never),
    ).rejects.toThrow(/roi[\s\S]*(screenshot|click)/);
    expect(calls).toEqual([]);
  });

  it('move con roi se rechaza y no mueve el ratón', async () => {
    const { b, calls } = backend();
    const tool = createComputerTool(config, b);
    await expect(tool.execute('1', { action: 'move', x: 10, y: 10, roi } as never)).rejects.toThrow(
      /roi/,
    );
    expect(calls).toEqual([]);
  });

  it('el error está en castellano y dice que no se ha tocado nada', async () => {
    const { b } = backend();
    const tool = createComputerTool(config, b);
    await expect(tool.execute('1', { action: 'move', x: 1, y: 1, roi } as never)).rejects.toThrow(
      /no he (movido|tocado) nada/i,
    );
  });

  it('sin roi (o roi null) move y drag siguen igual (caracterización)', async () => {
    const { b, calls } = backend();
    const tool = createComputerTool(config, b);
    await tool.execute('1', { action: 'move', x: 10, y: 20 } as never);
    await tool.execute('1', { action: 'move', x: 11, y: 21, roi: null } as never);
    await tool.execute('1', { action: 'drag', x: 1, y: 2, toX: 3, toY: 4 } as never);
    expect(calls).toEqual(['move 10,20', 'move 11,21', 'drag 1,2->3,4']);
  });

  it('click con roi sigue siendo relativo a la roi (caracterización)', async () => {
    const { b, calls } = backend();
    const tool = createComputerTool(config, b);
    await tool.execute('1', { action: 'click', x: 10, y: 10, roi } as never);
    expect(calls).toEqual(['click 610,310']);
  });

  it('una roi mal formada se explica en castellano (y no hace clic)', async () => {
    const { b, calls } = backend();
    const tool = createComputerTool(config, b);
    await expect(
      tool.execute('1', {
        action: 'click',
        x: 1,
        y: 1,
        roi: { x: 'a', y: 0, width: 1, height: 1 },
      } as never),
    ).rejects.toThrow(/roi necesita x, y, width y height/);
    await expect(
      tool.execute('1', {
        action: 'click',
        x: 1,
        y: 1,
        roi: { x: 0, y: 0, width: -1, height: 1 },
      } as never),
    ).rejects.toThrow(/roi no puede tener width ni height negativos/);
    expect(calls).toEqual([]);
  });
});
