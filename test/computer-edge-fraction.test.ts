import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import type { Screenshot } from '../src/screen/verify.js';
import { createComputerTool, type ScreenBackend } from '../src/tools/computer.js';

/**
 * Una coordenada fraccionaria en el último píxel de la captura (p. ej. x=1279.7
 * en una imagen de 1280 de ancho) está DENTRO de la imagen, pero al escalar a
 * la pantalla real se redondeaba a 1920 en una pantalla de 1920 y se rechazaba
 * con «fuera de la pantalla». Ahora se queda en el último píxel real (1919).
 * Lo que de verdad está fuera de la imagen sigue rechazándose sin tocar nada,
 * y con roi igual: un punto roi+x fuera de la imagen se rechaza como «fuera de
 * la imagen» antes de escalar.
 */
const config = {
  screenshotMaxEdge: 1280,
  screenshotQuality: 80,
  verifyActions: false,
  verifySettleMs: 1,
} as Config;

function backend(native = { width: 1920, height: 1080 }) {
  const calls: string[] = [];
  const shot = async (): Promise<Screenshot> => ({
    image: Buffer.from('f'),
    mimeType: 'image/jpeg',
    width: 1280,
    height: 720,
    nativeWidth: native.width,
    nativeHeight: native.height,
  });
  const b = {
    screenshot: shot,
    screenSize: async () => native,
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

async function withShot(native?: { width: number; height: number }) {
  const { b, calls } = backend(native);
  const tool = createComputerTool(config, b);
  await tool.execute('s', { action: 'screenshot' } as never);
  return { tool, calls };
}

describe('computer · borde derecho/inferior con coordenadas fraccionarias', () => {
  it('click en x=1279.7, y=719.6 de una captura 1280x720 cae en el último píxel real', async () => {
    const { tool, calls } = await withShot();
    await tool.execute('1', { action: 'click', x: 1279.7, y: 719.6 } as never);
    expect(calls).toEqual(['click 1919,1079']);
  });

  it('move y drag también se quedan en el último píxel', async () => {
    const { tool, calls } = await withShot();
    await tool.execute('1', { action: 'move', x: 1279.9, y: 10 } as never);
    await tool.execute('1', { action: 'drag', x: 10, y: 10, toX: 1279.8, toY: 719.9 } as never);
    expect(calls).toEqual(['move 1919,15', 'drag 15,15->1919,1079']);
  });

  it('sin captura previa (escala 1) x=1919.6 en 1920 no se rechaza', async () => {
    const { b, calls } = backend();
    const tool = createComputerTool(config, b);
    await tool.execute('1', { action: 'click', x: 1919.6, y: 1079.5 } as never);
    expect(calls).toEqual(['click 1919,1079']);
  });

  it('click con roi en el último píxel de la imagen cae en el último píxel real', async () => {
    const { tool, calls } = await withShot();
    const roi = { x: 1180, y: 600, width: 100, height: 120 };
    await tool.execute('1', { action: 'click', x: 99.8, y: 119.8, roi } as never);
    expect(calls).toEqual(['click 1919,1079']);
  });

  it('roi+x fuera de la imagen se rechaza como «fuera de la imagen» sin clicar', async () => {
    const { tool, calls } = await withShot();
    const roi = { x: 1200, y: 0, width: 200, height: 100 };
    await expect(
      tool.execute('1', { action: 'click', x: 150, y: 10, roi } as never),
    ).rejects.toThrow(/fuera de la imagen/);
    const neg = { x: -20, y: 0, width: 200, height: 100 };
    await expect(
      tool.execute('1', { action: 'click', x: 5, y: 10, roi: neg } as never),
    ).rejects.toThrow(/fuera de la imagen/);
    expect(calls).toEqual([]);
  });

  it('lo que está fuera de la imagen sigue rechazándose (caracterización)', async () => {
    const { tool, calls } = await withShot();
    await expect(tool.execute('1', { action: 'click', x: 1280, y: 10 } as never)).rejects.toThrow(
      /fuera de la imagen/,
    );
    await expect(tool.execute('1', { action: 'click', x: -0.1, y: 10 } as never)).rejects.toThrow(
      /fuera de la imagen/,
    );
    await expect(
      tool.execute('1', { action: 'drag', x: 1, y: 1, toX: 5, toY: 720 } as never),
    ).rejects.toThrow(/fuera de la imagen/);
    expect(calls).toEqual([]);
  });

  it('dentro de la imagen el escalado no cambia (caracterización)', async () => {
    const { tool, calls } = await withShot();
    await tool.execute('1', { action: 'click', x: 640, y: 360 } as never);
    await tool.execute('1', { action: 'click', x: 1279, y: 719 } as never);
    expect(calls).toEqual(['click 960,540', 'click 1919,1079']);
  });
});
