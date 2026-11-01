import { describe, expect, it } from 'vitest';

/**
 * Un elemento de lote no pasa por el esquema: `clicks: true` contaba como 1 clic
 * y `clicks: [2]` como doble clic (Number(true)=1, Number([2])=2). Ahora solo un
 * número (o su texto) cuenta; lo demás se niega y no se hace clic.
 * Backend falso: nada toca un PC.
 */

import type { Config } from '../src/config.js';
import type { Screenshot } from '../src/screen/verify.js';
import { type ActionGate, createComputerTool, type ScreenBackend } from '../src/tools/computer.js';

const clicks: unknown[] = [];
const backend: ScreenBackend = {
  screenshot: async (): Promise<Screenshot> => ({
    image: Buffer.from('frame'),
    mimeType: 'image/jpeg',
    width: 1280,
    height: 720,
    nativeWidth: 1280,
    nativeHeight: 720,
  }),
  click: async (_x, _y, o) => {
    clicks.push(o?.clicks ?? 1);
  },
  move: async () => {},
  drag: async () => {},
  type: async () => {},
  key: async () => {},
  screenSize: async () => ({ width: 1280, height: 720 }),
};

const allowAll: ActionGate = () => ({ verdict: 'allow', reason: '' });
const config = { screenshotMaxEdge: 1280, verifyActions: false, verifySettleMs: 1 } as Config;

async function said(args: Record<string, unknown>): Promise<string> {
  const tool = createComputerTool(config, backend, allowAll);
  try {
    const r = await tool.execute('t', args as never);
    return r.content.map((c) => ('text' in c ? (c.text ?? '') : '')).join('\n');
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

describe('computer: clicks solo con números', () => {
  it('true, [2] o un objeto en clicks se niegan y no se hace clic', async () => {
    for (const v of [true, [2], { n: 2 }, '']) {
      clicks.length = 0;
      const out = await said({
        action: 'batch',
        actions: [{ action: 'click', x: 5, y: 5, clicks: v }],
      });
      expect(out, JSON.stringify(v)).toMatch(/clicks debe ser un número entero de 1 a 5/);
      expect(clicks, JSON.stringify(v)).toEqual([]);
    }
  });

  it('un número o su texto siguen valiendo', async () => {
    clicks.length = 0;
    await said({ action: 'click', x: 5, y: 5, clicks: 2 });
    await said({ action: 'batch', actions: [{ action: 'click', x: 5, y: 5, clicks: '3' }] });
    await said({ action: 'click', x: 5, y: 5 });
    expect(clicks).toEqual([2, 3, 1]);
  });
});
