import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Pruebas de caracterización de la herramienta `computer` (acciones sueltas).
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

describe('computer · verificación cuando falla una captura', () => {
  it('si la captura previa falla, la acción se hace igual y se dice que no se pudo verificar', async () => {
    const { backend, calls } = fake({ failScreenshotAt: [1] });
    const tool = createComputerTool(makeConfig({ verifyActions: true }), backend, allowAll);
    const r = await tool.execute('k', { action: 'key', key: 'enter' });
    // Antes: devolvía «Pressed enter» sin haber pulsado nada.
    expect(calls).toEqual(['screenshot', 'key:enter']);
    expect(textOf(r)).toMatch(/^Pulsada la tecla enter\nVERIFICACION: no he podido comparar/);
    expect(textOf(r)).toMatch(/captura previa ha fallado \(captura rota\)/);
    expect(r.details).toMatchObject({ verified: null });
    expect(compareFrames).not.toHaveBeenCalled();
  });

  it('un clic también se ejecuta aunque falle la captura previa', async () => {
    const { backend, calls } = fake({ failScreenshotAt: [2] });
    const tool = createComputerTool(makeConfig({ verifyActions: true }), backend, allowAll);
    await tool.execute('s', { action: 'screenshot' });
    const r = await tool.execute('c', { action: 'click', x: 640, y: 360 });
    expect(calls).toContain('click:960,540:left:1');
    expect(r.details).toMatchObject({ verified: null, localRatio: 0 });
  });

  it('si falla la captura posterior, la acción está hecha y se dice que no se sabe si tuvo efecto', async () => {
    const { backend, calls } = fake({ failScreenshotAt: [2] });
    const tool = createComputerTool(makeConfig({ verifyActions: true }), backend, allowAll);
    const r = await tool.execute('t', { action: 'type', text: 'hola' });
    expect(calls).toEqual(['screenshot', 'type:hola', 'screenshot']);
    expect(textOf(r)).toMatch(/captura posterior ha fallado/);
    expect(textOf(r)).not.toMatch(/NO ha cambiado/);
    expect(r.details).toMatchObject({ verified: null });
  });
});
