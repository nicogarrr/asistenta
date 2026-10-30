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

function images(r: { content: Array<{ type: string }> }): number {
  return r.content.filter((b) => b.type === 'image').length;
}

beforeEach(() => {
  compareFrames.mockReset();
  compareFrames.mockResolvedValue({
    changed: true,
    ratio: 0.2,
    localRatio: 0.5,
    movedAway: false,
    verdict: 'VERIFICACION: ok.',
  });
});

describe('computer · look: la pantalla de después en la misma llamada', () => {
  it('sin look, nada cambia: ni imagen extra ni captura extra', async () => {
    const { backend, calls } = fake();
    const tool = createComputerTool(makeConfig(), backend, allowAll);
    const r = await tool.execute('k', { action: 'key', key: 'enter' });
    expect(images(r)).toBe(0);
    expect(calls).toEqual(['key:enter']);
  });

  it('con verificación, reutiliza la captura de después (cero capturas extra)', async () => {
    const { backend, calls } = fake();
    const tool = createComputerTool(makeConfig({ verifyActions: true }), backend, allowAll);
    const r = await tool.execute('c', { action: 'click', x: 10, y: 10, look: true });
    expect(calls.filter((c) => c === 'screenshot')).toHaveLength(2);
    expect(images(r)).toBe(1);
    const img = r.content.find((b) => b.type === 'image') as { data: string };
    expect(Buffer.from(img.data, 'base64').toString()).toBe('frame-2');
    const texts = r.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text);
    expect(texts.join('\n')).toMatch(/Screenshot after the action: 1280x720/);
  });

  it('sin verificación, hace una sola captura tras la acción', async () => {
    const { backend, calls } = fake();
    const tool = createComputerTool(makeConfig(), backend, allowAll);
    const r = await tool.execute('t', { action: 'type', text: 'hola', look: true });
    expect(calls).toEqual(['type:hola', 'screenshot']);
    expect(images(r)).toBe(1);
  });

  it('la captura de look fija el espacio de coordenadas del siguiente clic', async () => {
    const { backend, calls } = fake();
    const tool = createComputerTool(makeConfig(), backend, allowAll);
    await tool.execute('m', { action: 'move', x: 5, y: 5, look: true });
    await tool.execute('c', { action: 'click', x: 640, y: 360 });
    // Sin look, el primer clic sin captura previa iría 1:1; con look ya escala.
    expect(calls).toContain('click:960,540:left:1');
  });

  it('batch con look: una imagen al final, reutilizando la verificación del lote', async () => {
    const { backend, calls } = fake();
    const tool = createComputerTool(makeConfig({ verifyActions: true }), backend, allowAll);
    const r = await tool.execute('b', {
      action: 'batch',
      look: true,
      actions: [
        { action: 'key', key: 'a' },
        { action: 'key', key: 'b' },
      ],
    });
    expect(calls.filter((c) => c === 'screenshot')).toHaveLength(2);
    expect(images(r)).toBe(1);
  });

  it('si la captura de después falla, la acción ya está hecha y se dice', async () => {
    const { backend, calls } = fake({ failScreenshotAt: [1] });
    const tool = createComputerTool(makeConfig(), backend, allowAll);
    const r = await tool.execute('k', { action: 'key', key: 'enter', look: true });
    expect(calls).toEqual(['key:enter', 'screenshot']);
    expect(images(r)).toBe(0);
    const texts = r.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(texts).toMatch(/Pressed enter/);
    expect(texts).toMatch(/No he podido capturar la pantalla después/);
  });

  it('el modelo conoce la opción', () => {
    const { backend } = fake();
    const tool = createComputerTool(makeConfig(), backend, allowAll);
    expect(tool.description).toMatch(/look: true/);
    expect(JSON.stringify(tool.parameters)).toMatch(/"look"/);
  });
});
