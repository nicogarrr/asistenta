import { describe, expect, it } from 'vitest';

/**
 * Una llamada filtrada (o un lote) con x/y vacías no puede convertirse en un
 * clic en 0,0. `Number(null)`, `Number('')`, `Number(true)` y `Number([5])` dan
 * un número, así que antes «x: null» acababa clicando la esquina de arriba a la
 * izquierda. Ahora se niega con un error en español y no se mueve nada.
 * Backend falso: nada toca un PC.
 */

import type { Config } from '../src/config.js';
import type { Screenshot } from '../src/screen/verify.js';
import {
  type ActionGate,
  createComputerTool,
  normalizeAction,
  type ScreenBackend,
} from '../src/tools/computer.js';

function fake() {
  const calls: string[] = [];
  const backend: ScreenBackend = {
    screenshot: async (): Promise<Screenshot> => ({
      image: Buffer.from('frame'),
      mimeType: 'image/jpeg',
      width: 1280,
      height: 720,
      nativeWidth: 1920,
      nativeHeight: 1080,
    }),
    click: async (x, y) => {
      calls.push(`click:${x},${y}`);
    },
    move: async (x, y) => {
      calls.push(`move:${x},${y}`);
    },
    drag: async (x, y, toX, toY) => {
      calls.push(`drag:${x},${y}->${toX},${toY}`);
    },
    type: async (text) => {
      calls.push(`type:${text}`);
    },
    key: async (key) => {
      calls.push(`key:${key}`);
    },
    screenSize: async () => ({ width: 1920, height: 1080 }),
  };
  return { backend, calls };
}

const allowAll: ActionGate = () => ({ verdict: 'allow', reason: '' });
const config = { screenshotMaxEdge: 1280, verifyActions: false, verifySettleMs: 1 } as Config;

async function said(
  tool: ReturnType<typeof createComputerTool>,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    const r = await tool.execute('t', args as never);
    return r.content.map((c) => ('text' in c ? (c.text ?? '') : '')).join('\n');
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const EMPTY: unknown[] = [null, '', '   ', true, false, [5], {}];

describe('computer: x/y vacías se niegan, no clican en 0,0', () => {
  it('click, move y drag con x/y vacías no hacen nada', async () => {
    const { backend, calls } = fake();
    const tool = createComputerTool(config, backend, allowAll);
    for (const v of EMPTY) {
      expect(await said(tool, { action: 'click', x: v, y: v })).toMatch(/necesita x e y numéricas/);
      expect(await said(tool, { action: 'move', x: v, y: 10 })).toMatch(/necesita x e y numéricas/);
      expect(await said(tool, { action: 'drag', x: 10, y: 10, toX: v, toY: v })).toMatch(
        /numéricas/,
      );
      expect(
        await said(tool, {
          action: 'click',
          x: v,
          y: 1,
          roi: { x: 0, y: 0, width: 50, height: 50 },
        }),
      ).toMatch(/necesita x e y numéricas/);
    }
    expect(calls).toEqual([]);
  });

  it('en un lote, un clic con x/y vacías se niega y no se ejecuta', async () => {
    const { backend, calls } = fake();
    const tool = createComputerTool(config, backend, allowAll);
    const m = await said(tool, { action: 'batch', actions: [{ action: 'click', x: null, y: '' }] });
    expect(m).toMatch(/necesita x e y numéricas/);
    expect(calls).toEqual([]);
  });

  it('una roi con campos vacíos se niega en vez de valer 0', async () => {
    const { backend, calls } = fake();
    const tool = createComputerTool(config, backend, allowAll);
    const m = await said(tool, {
      action: 'click',
      x: 1,
      y: 1,
      roi: { x: null, y: '', width: 50, height: 50 },
    });
    expect(m).toMatch(/roi necesita x, y, width y height numéricos/);
    expect(calls).toEqual([]);
  });

  it('números de verdad y cadenas numéricas siguen funcionando', async () => {
    const { backend, calls } = fake();
    const tool = createComputerTool(config, backend, allowAll);
    await said(tool, { action: 'click', x: 100, y: 50 });
    await said(tool, { action: 'click', x: '100', y: ' 50 ' });
    await said(tool, { action: 'move', x: 0, y: 0 });
    expect(calls).toEqual(['click:100,50', 'click:100,50', 'move:0,0']);
  });

  it('normalizeAction: una llamada filtrada sin x/y no se queda en 0,0', () => {
    for (const text of [
      '{"name":"computer","arguments":{"action":"click"}}',
      '{"action":"click","x":null,"y":null}',
      '{"action":"click","x":"","y":""}',
      '{"action":"move","x":null,"y":3}',
    ]) {
      const a = normalizeAction(text) as { x: number; y: number };
      expect(Number.isFinite(a.x) && Number.isFinite(a.y)).toBe(false);
    }
    expect(normalizeAction('{"action":"click","x":"12","y":34}')).toMatchObject({ x: 12, y: 34 });
  });
});
