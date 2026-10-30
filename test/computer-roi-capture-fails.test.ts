import { describe, expect, it } from 'vitest';

/**
 * Si la captura falla (pantalla bloqueada, escritorio seguro…), una captura con
 * roi devolvía una imagen vacía: llegaba al modelo, que rechaza una imagen vacía
 * y falla el turno, y con send true se mandaba al chat. Ahora es un error claro
 * y no se manda nada. Backend falso: nada toca un PC.
 */

import type { Config } from '../src/config.js';
import { type ActionGate, createComputerTool, type ScreenBackend } from '../src/tools/computer.js';

const backend: ScreenBackend = {
  screenshot: async () => {
    throw new Error('pantalla bloqueada');
  },
  click: async () => {},
  move: async () => {},
  drag: async () => {},
  type: async () => {},
  key: async () => {},
  screenSize: async () => ({ width: 1280, height: 720 }),
};

const allowAll: ActionGate = () => ({ verdict: 'allow', reason: '' });
const config = { screenshotMaxEdge: 1280, verifyActions: false, verifySettleMs: 1 } as Config;
const roi = { x: 0, y: 0, width: 100, height: 100 };

describe('computer: captura con roi que falla', () => {
  it('da un error claro, sin imagen vacía y sin mandar nada al chat', async () => {
    const photos: Buffer[] = [];
    const tool = createComputerTool(config, backend, allowAll, async (b) => {
      photos.push(b);
      return true;
    });
    await expect(
      tool.execute('t', { action: 'screenshot', roi, send: true } as never),
    ).rejects.toThrow(/no pude capturar la pantalla/);
    const r = await tool.execute('t', {
      action: 'batch',
      actions: [{ action: 'screenshot', roi, send: true }],
    } as never);
    expect(r.content.some((c) => c.type === 'image')).toBe(false);
    expect(JSON.stringify(r.content)).toMatch(/pantalla bloqueada/);
    expect(photos).toEqual([]);
  });
});
