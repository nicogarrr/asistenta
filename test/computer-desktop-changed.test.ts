import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { type ActionGate, createComputerTool, type ScreenBackend } from '../src/tools/computer.js';

/**
 * Coordenadas de una captura vieja: si entre la captura y el clic cambia la
 * resolución, el escalado o el monitor principal (portátil al dock, la tele como
 * pantalla), el mismo píxel de la imagen cae en otro sitio. Antes se hacía el clic
 * igual, en el sitio equivocado; ahora se pide una captura nueva.
 */

function rig() {
  let native = { width: 1920, height: 1080 };
  const calls: string[] = [];
  const backend: ScreenBackend = {
    screenshot: async () => ({
      image: Buffer.from('f'),
      mimeType: 'image/jpeg',
      width: 1280,
      height: Math.round((1280 * native.height) / native.width),
      nativeWidth: native.width,
      nativeHeight: native.height,
    }),
    click: async (x, y) => {
      calls.push(`click:${x},${y}`);
    },
    move: async (x, y) => {
      calls.push(`move:${x},${y}`);
    },
    drag: async (x, y, tx, ty) => {
      calls.push(`drag:${x},${y}->${tx},${ty}`);
    },
    type: async () => {},
    key: async () => {},
    screenSize: async () => ({ ...native }),
  };
  const allow: ActionGate = () => ({ verdict: 'allow', reason: '' });
  const tool = createComputerTool({ verifyActions: false } as Config, backend, allow);
  return {
    tool,
    calls,
    setNative: (w: number, h: number) => {
      native = { width: w, height: h };
    },
  };
}

describe('computer · la pantalla cambió desde la última captura', () => {
  it('rechaza clic, move y drag con coordenadas de una captura de otra pantalla', async () => {
    const { tool, calls, setNative } = rig();
    await tool.execute('s', { action: 'screenshot' });
    setNative(2560, 1440);
    await expect(tool.execute('c', { action: 'click', x: 640, y: 360 })).rejects.toThrow(
      /ha cambiado de 1920x1080 a 2560x1440.*captura nueva/,
    );
    await expect(tool.execute('m', { action: 'move', x: 1, y: 1 })).rejects.toThrow(/ha cambiado/);
    await expect(tool.execute('d', { action: 'drag', x: 1, y: 1, toX: 2, toY: 2 })).rejects.toThrow(
      /ha cambiado/,
    );
    expect(calls).toEqual([]);
  });

  it('tras una captura nueva vuelve a funcionar con el nuevo escalado', async () => {
    const { tool, calls, setNative } = rig();
    await tool.execute('s', { action: 'screenshot' });
    setNative(2560, 1440);
    await tool.execute('s2', { action: 'screenshot' });
    await tool.execute('c', { action: 'click', x: 640, y: 360 });
    expect(calls).toEqual(['click:1280,720']);
  });

  it('en un batch, el paso afectado falla y los siguientes no se ejecutan', async () => {
    const { tool, calls, setNative } = rig();
    await tool.execute('s', { action: 'screenshot' });
    setNative(1280, 800);
    const r = await tool.execute('b', {
      action: 'batch',
      actions: [
        { action: 'click', x: 10, y: 10 },
        { action: 'click', x: 20, y: 20 },
      ],
    });
    expect(calls).toEqual([]);
    const text = r.content[0]?.type === 'text' ? r.content[0].text : '';
    expect(text).toMatch(/\[0\] click: FALLÓ — la pantalla ha cambiado/);
  });

  it('misma pantalla: sin cambios respecto a hoy', async () => {
    const { tool, calls } = rig();
    await tool.execute('s', { action: 'screenshot' });
    await tool.execute('c', { action: 'click', x: 640, y: 360 });
    expect(calls).toEqual(['click:960,540']);
  });
});
