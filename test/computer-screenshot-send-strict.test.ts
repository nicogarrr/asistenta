import { describe, expect, it } from 'vitest';

/**
 * Un elemento de lote no pasa por el esquema, así que `send` puede llegar como
 * texto. `send: "false"` (o "no", 1…) mandaba la captura al chat: una cadena no
 * vacía es verdadera. Ahora solo `send: true` la manda (más privado, nunca menos).
 * Backend falso: nada toca un PC.
 */

import type { Config } from '../src/config.js';
import type { Screenshot } from '../src/screen/verify.js';
import { type ActionGate, createComputerTool, type ScreenBackend } from '../src/tools/computer.js';

const backend: ScreenBackend = {
  screenshot: async (): Promise<Screenshot> => ({
    image: Buffer.from('frame'),
    mimeType: 'image/jpeg',
    width: 1280,
    height: 720,
    nativeWidth: 1280,
    nativeHeight: 720,
  }),
  click: async () => {},
  move: async () => {},
  drag: async () => {},
  type: async () => {},
  key: async () => {},
  screenSize: async () => ({ width: 1280, height: 720 }),
};

const allowAll: ActionGate = () => ({ verdict: 'allow', reason: '' });
const config = { screenshotMaxEdge: 1280, verifyActions: false, verifySettleMs: 1 } as Config;

function tool() {
  const photos: number[] = [];
  const t = createComputerTool(config, backend, allowAll, async (_b, o) => {
    photos.push(o.width);
    return true;
  });
  return { t, photos };
}

describe('computer: la captura solo va al chat con send exactamente true', () => {
  it('send "false", "no", 1 o "true" en un lote no mandan la captura', async () => {
    for (const send of ['false', 'no', 1, 'true', 'sí']) {
      const { t, photos } = tool();
      await t.execute('t', { action: 'batch', actions: [{ action: 'screenshot', send }] } as never);
      await t.execute('t', {
        action: 'batch',
        actions: [{ action: 'screenshot', send, roi: { x: 0, y: 0, width: 100, height: 100 } }],
      } as never);
      expect(photos, String(send)).toEqual([]);
    }
  });

  it('send true sigue mandando la captura, entera o recortada', async () => {
    const { t, photos } = tool();
    await t.execute('t', { action: 'screenshot', send: true } as never);
    await t.execute('t', {
      action: 'batch',
      actions: [{ action: 'screenshot', send: true }],
    } as never);
    expect(photos.length).toBe(2);
  });
});
