import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Interruptor PA_COMPUTER_USE=0 de Computer Use. Base copiada de las pruebas de caracterización.
 *
 * Fijan lo que hace HOY el control del escritorio, que funciona bien en el PC de
 * Nico, para que cualquier mejora posterior no lo rompa sin que salte un test:
 * escalado imagen→pantalla real (incluido el caso DPI 2160x1440→1280x853),
 * textos que ve el modelo, verificación antes/después y errores. Todo contra un
 * backend falso: ningún test mueve el ratón ni captura una pantalla real.
 */

const compareFrames = vi.fn();
vi.mock('../src/screen/verify.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/screen/verify.js')>();
  return { ...real, compareFrames: (...args: unknown[]) => compareFrames(...args) };
});

import type { Config } from '../src/config.js';
import type { Screenshot } from '../src/screen/verify.js';
import { type ActionGate, createComputerTool, type ScreenBackend } from '../src/tools/computer.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    screenshotMaxEdge: 1280,
    screenshotQuality: 80,
    verifyActions: false,
    verifySettleMs: 1,
    ...overrides,
  } as Config;
}

interface FakeOpts {
  view?: { width: number; height: number };
  native?: { width: number; height: number };
  failScreenshotAt?: number[];
}

function fake(opts: FakeOpts = {}) {
  const view = opts.view ?? { width: 1280, height: 720 };
  const native = opts.native ?? { width: 1920, height: 1080 };
  const calls: string[] = [];
  let shots = 0;
  const backend: ScreenBackend = {
    screenshot: async (): Promise<Screenshot> => {
      shots++;
      calls.push('screenshot');
      if (opts.failScreenshotAt?.includes(shots)) throw new Error('captura rota');
      return {
        image: Buffer.from(`frame-${shots}`),
        mimeType: 'image/jpeg',
        width: view.width,
        height: view.height,
        nativeWidth: native.width,
        nativeHeight: native.height,
      };
    },
    click: async (x, y, o) => {
      calls.push(`click:${x},${y}:${o?.button ?? '-'}:${o?.clicks ?? '-'}`);
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
    screenSize: async () => ({ ...native }),
  };
  return { backend, calls };
}

const allowAll: ActionGate = () => ({ verdict: 'allow', reason: '' });

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  return first && first.type === 'text' ? (first.text ?? '') : '';
}

beforeEach(() => {
  compareFrames.mockReset();
});

describe('computer · interruptor PA_COMPUTER_USE', () => {
  it.each([
    { action: 'screenshot' },
    { action: 'click', x: 1, y: 1 },
    { action: 'type', text: 'hola' },
    { action: 'key', key: 'win+r' },
    { action: 'batch', actions: [{ action: 'key', key: 'enter' }] },
  ])('apagado: $action se rechaza sin tocar la pantalla', async (args) => {
    const { backend, calls } = fake();
    const tool = createComputerTool(
      makeConfig({ computerUse: false, verifyActions: true }),
      backend,
      allowAll,
    );
    await expect(tool.execute('k', args as never)).rejects.toThrow(/PA_COMPUTER_USE=0/);
    expect(calls).toEqual([]);
  });

  it('el mensaje está en castellano y dice cómo activarlo', async () => {
    const { backend } = fake();
    const tool = createComputerTool(makeConfig({ computerUse: false }), backend, allowAll);
    await expect(tool.execute('k', { action: 'screenshot' })).rejects.toThrow(
      /desactivado.*quita esa línea/,
    );
  });

  it('encendido o sin el campo: todo igual que antes', async () => {
    for (const cfg of [makeConfig({ computerUse: true }), makeConfig()]) {
      const { backend, calls } = fake();
      const tool = createComputerTool(cfg, backend, allowAll);
      const r = await tool.execute('k', { action: 'key', key: 'enter' });
      expect(textOf(r)).toMatch(/^Pressed enter/);
      expect(calls).toEqual(['key:enter']);
    }
  });

  it('loadConfig: PA_COMPUTER_USE=0 lo apaga y por defecto está encendido', async () => {
    // loadConfig guarda la config en caché: módulo nuevo para cada lectura.
    const fresh = async () => {
      vi.resetModules();
      return (await import('../src/config.js')).loadConfig();
    };
    const prev = process.env.PA_COMPUTER_USE;
    try {
      delete process.env.PA_COMPUTER_USE;
      expect((await fresh()).computerUse).toBe(true);
      process.env.PA_COMPUTER_USE = '0';
      expect((await fresh()).computerUse).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.PA_COMPUTER_USE;
      else process.env.PA_COMPUTER_USE = prev;
    }
  });
});
