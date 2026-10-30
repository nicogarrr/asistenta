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
import {
  type ActionGate,
  createComputerTool,
  normalizeAction,
  type ScreenBackend,
  toRealCoordinates,
} from '../src/tools/computer.js';

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
  compareFrames.mockResolvedValue({
    changed: true,
    ratio: 0.2,
    localRatio: 0.5,
    movedAway: false,
    verdict: 'VERIFICACION: la accion ha tenido efecto (20% de la imagen).',
  });
});

describe('computer · screenshot', () => {
  it('devuelve la imagen reducida y dice el tamaño real del escritorio', async () => {
    const { backend } = fake();
    const tool = createComputerTool(makeConfig(), backend, allowAll);
    const r = await tool.execute('t', { action: 'screenshot' });
    expect(textOf(r)).toBe('Screenshot 1280x720. Origin top-left. Real desktop is 1920x1080.');
    const img = r.content[1] as { type: string; mimeType: string; data: string };
    expect(img.type).toBe('image');
    expect(img.mimeType).toBe('image/jpeg');
    expect(Buffer.from(img.data, 'base64').toString()).toBe('frame-1');
    expect(r.details).toMatchObject({
      width: 1280,
      height: 720,
      nativeWidth: 1920,
      nativeHeight: 1080,
      maxEdge: 1280,
      quality: 80,
    });
  });

  it('no menciona el escritorio real cuando la captura no está reducida', async () => {
    const { backend } = fake({ view: { width: 1920, height: 1080 } });
    const tool = createComputerTool(makeConfig(), backend, allowAll);
    const r = await tool.execute('t', { action: 'screenshot' });
    expect(textOf(r)).toBe('Screenshot 1920x1080. Origin top-left.');
  });

  it('send: true envía la foto al chat y lo dice; si falla, también lo dice', async () => {
    const { backend } = fake();
    const sent: Array<{ width: number; height: number }> = [];
    const ok = createComputerTool(makeConfig(), backend, allowAll, async (_b, o) => {
      sent.push(o);
      return true;
    });
    expect(textOf(await ok.execute('t', { action: 'screenshot', send: true }))).toMatch(
      / Enviada al chat\.$/,
    );
    expect(sent).toEqual([{ width: 1280, height: 720 }]);
    const ko = createComputerTool(makeConfig(), backend, allowAll, async () => false);
    expect(textOf(await ko.execute('t', { action: 'screenshot', send: true }))).toMatch(
      / No he podido enviarla al chat\.$/,
    );
    // Sin canal para enviar, la captura sigue funcionando y no promete nada.
    const none = createComputerTool(makeConfig(), backend, allowAll);
    expect(textOf(await none.execute('t', { action: 'screenshot', send: true }))).not.toMatch(
      /chat/,
    );
  });

  it('pide al backend la reducción configurada', async () => {
    const { backend } = fake();
    const setScaling = vi.fn();
    createComputerTool(makeConfig({ screenshotMaxEdge: 1000, screenshotQuality: 70 }), {
      ...backend,
      setScaling,
    } as ScreenBackend);
    expect(setScaling).toHaveBeenCalledWith(1000, 70);
  });
});

describe('computer · coordenadas', () => {
  it('toRealCoordinates escala por eje y redondea', () => {
    expect(
      toRealCoordinates(640, 360, { width: 1280, height: 720 }, { width: 1920, height: 1080 }),
    ).toEqual({ x: 960, y: 540 });
    // Ejemplo del documento de DPI: 1180,803 en 1280x853 → 1991,1356 en 2160x1440.
    expect(
      toRealCoordinates(1180, 803, { width: 1280, height: 853 }, { width: 2160, height: 1440 }),
    ).toEqual({ x: 1991, y: 1356 });
    // Vista degenerada: no divide por cero.
    expect(toRealCoordinates(5, 6, { width: 0, height: 0 }, { width: 100, height: 100 })).toEqual({
      x: 5,
      y: 6,
    });
  });

  it('un clic tras la captura se traduce a píxeles físicos', async () => {
    const { backend, calls } = fake();
    const tool = createComputerTool(makeConfig(), backend, allowAll);
    await tool.execute('s', { action: 'screenshot' });
    const r = await tool.execute('c', { action: 'click', x: 640, y: 360 });
    expect(calls).toContain('click:960,540:left:1');
    expect(textOf(r)).toBe('Clicked 960,540');
    expect(r.details).toMatchObject({ x: 960, y: 540, verified: null });
  });

  it('caso DPI 2160x1440 visto a 1280x853', async () => {
    const { backend, calls } = fake({
      view: { width: 1280, height: 853 },
      native: { width: 2160, height: 1440 },
    });
    const tool = createComputerTool(makeConfig(), backend, allowAll);
    await tool.execute('s', { action: 'screenshot' });
    await tool.execute('c', { action: 'click', x: 1180, y: 803 });
    await tool.execute('m', { action: 'move', x: 1180, y: 803 });
    expect(calls).toContain('click:1991,1356:left:1');
    expect(calls).toContain('move:1991,1356');
  });

  it('sin captura previa, las coordenadas se toman como píxeles reales', async () => {
    const { backend, calls } = fake();
    const tool = createComputerTool(makeConfig(), backend, allowAll);
    await tool.execute('c', { action: 'click', x: 100, y: 200 });
    expect(calls).toEqual(['click:100,200:left:1']);
  });

  it('pasa botón y número de clics', async () => {
    const { backend, calls } = fake();
    const tool = createComputerTool(makeConfig(), backend, allowAll);
    await tool.execute('s', { action: 'screenshot' });
    await tool.execute('c', { action: 'click', x: 10, y: 10, button: 'right', clicks: 2 });
    expect(calls).toContain('click:15,15:right:2');
  });

  it('rechaza coordenadas fuera de la imagen o no numéricas sin tocar el ratón', async () => {
    const { backend, calls } = fake();
    const tool = createComputerTool(makeConfig(), backend, allowAll);
    await tool.execute('s', { action: 'screenshot' });
    await expect(tool.execute('c', { action: 'click', x: 1280, y: 10 })).rejects.toThrow(
      /outside the 1280x720 image/,
    );
    await expect(tool.execute('c', { action: 'click', x: -1, y: 10 })).rejects.toThrow(/outside/);
    await expect(
      tool.execute('c', { action: 'click', x: 'a' as unknown as number, y: 10 }),
    ).rejects.toThrow(/numeric x and y/);
    expect(calls.filter((c) => c.startsWith('click'))).toEqual([]);
  });

  it('drag escala los dos extremos', async () => {
    const { backend, calls } = fake();
    const tool = createComputerTool(makeConfig(), backend, allowAll);
    await tool.execute('s', { action: 'screenshot' });
    const r = await tool.execute('d', { action: 'drag', x: 100, y: 100, toX: 200, toY: 300 });
    expect(calls).toContain('drag:150,150->300,450');
    expect(textOf(r)).toBe('Dragged 150,150 to 300,450');
    await expect(
      tool.execute('d', { action: 'drag', x: 100, y: 100, toX: 5000, toY: 1 }),
    ).rejects.toThrow(/outside/);
  });

  it('roi: un clic relativo al recorte se traduce a la pantalla completa', async () => {
    const { backend, calls } = fake();
    const tool = createComputerTool(makeConfig(), backend, allowAll);
    await tool.execute('s', { action: 'screenshot' });
    const r = await tool.execute('c', {
      action: 'click',
      x: 10,
      y: 20,
      roi: { x: 100, y: 50, width: 200, height: 100 },
    });
    expect(calls).toContain('click:165,105:left:1');
    expect(textOf(r)).toBe('Clicked 165,105 (roi-relative 10,20)');
    expect(r.details).toMatchObject({ viewX: 110, viewY: 70 });
  });
});

describe('computer · teclado', () => {
  it('type escribe el texto y cuenta caracteres; vacío es un error', async () => {
    const { backend, calls } = fake();
    const tool = createComputerTool(makeConfig(), backend, allowAll);
    const r = await tool.execute('t', { action: 'type', text: 'hola ñandú' });
    expect(calls).toEqual(['type:hola ñandú']);
    expect(textOf(r)).toBe('Typed 10 characters');
    await expect(tool.execute('t', { action: 'type', text: '' })).rejects.toThrow(/requires text/);
  });

  it('key pulsa el acorde; vacío es un error', async () => {
    const { backend, calls } = fake();
    const tool = createComputerTool(makeConfig(), backend, allowAll);
    const r = await tool.execute('k', { action: 'key', key: 'ctrl+s' });
    expect(calls).toEqual(['key:ctrl+s']);
    expect(textOf(r)).toBe('Pressed ctrl+s');
    await expect(tool.execute('k', { action: 'key', key: '' })).rejects.toThrow(/key name/);
  });

  it('una acción desconocida es un error', async () => {
    const { backend } = fake();
    const tool = createComputerTool(makeConfig(), backend, allowAll);
    await expect(tool.execute('x', { action: 'scroll' as unknown as 'click' })).rejects.toThrow(
      /unknown action/,
    );
  });
});

describe('computer · verificación antes/después', () => {
  it('apagada: ninguna captura extra', async () => {
    const { backend, calls } = fake();
    const tool = createComputerTool(makeConfig(), backend, allowAll);
    await tool.execute('k', { action: 'key', key: 'enter' });
    expect(calls).toEqual(['key:enter']);
    expect(compareFrames).not.toHaveBeenCalled();
  });

  it('encendida: captura antes, actúa, captura después y añade el veredicto', async () => {
    const { backend, calls } = fake();
    const tool = createComputerTool(makeConfig({ verifyActions: true }), backend, allowAll);
    await tool.execute('s', { action: 'screenshot' });
    calls.length = 0;
    const r = await tool.execute('c', { action: 'click', x: 640, y: 360 });
    expect(calls).toEqual(['screenshot', 'click:960,540:left:1', 'screenshot']);
    // El punto se compara en el espacio de la imagen (no el físico), radio 48.
    expect(compareFrames).toHaveBeenCalledWith(Buffer.from('frame-2'), Buffer.from('frame-3'), {
      at: { x: 640, y: 360 },
      radius: 48,
    });
    expect(textOf(r)).toBe(
      'Clicked 960,540\nVERIFICACION: la accion ha tenido efecto (20% de la imagen).',
    );
    expect(r.details).toMatchObject({ verified: true, localRatio: 0.5 });
  });

  it('type, key y drag se verifican sin punto; move nunca se verifica', async () => {
    const { backend, calls } = fake();
    const tool = createComputerTool(makeConfig({ verifyActions: true }), backend, allowAll);
    await tool.execute('t', { action: 'type', text: 'x' });
    expect(compareFrames).toHaveBeenLastCalledWith(expect.any(Buffer), expect.any(Buffer), {});
    calls.length = 0;
    await tool.execute('m', { action: 'move', x: 1, y: 1 });
    expect(calls).toEqual(['move:1,1']);
  });

  it('si la captura posterior falla, la acción ya está hecha y queda sin verificar', async () => {
    const { backend, calls } = fake({ failScreenshotAt: [2] });
    const tool = createComputerTool(makeConfig({ verifyActions: true }), backend, allowAll);
    const r = await tool.execute('k', { action: 'key', key: 'enter' });
    expect(calls).toEqual(['screenshot', 'key:enter', 'screenshot']);
    expect(r.details).toMatchObject({ verified: null });
  });

  it('veredicto «no ha cambiado» llega tal cual al modelo', async () => {
    compareFrames.mockResolvedValueOnce({
      changed: false,
      ratio: 0,
      localRatio: 0,
      movedAway: false,
      verdict: 'VERIFICACION: la pantalla NO ha cambiado.',
    });
    const { backend } = fake();
    const tool = createComputerTool(makeConfig({ verifyActions: true }), backend, allowAll);
    const r = await tool.execute('c', { action: 'click', x: 1, y: 1 });
    expect(textOf(r)).toMatch(/NO ha cambiado/);
    expect(r.details).toMatchObject({ verified: false });
  });
});

describe('computer · contrato con el modelo', () => {
  it('es secuencial y la descripción exige capturar antes de hacer clic', () => {
    const { backend } = fake();
    const tool = createComputerTool(makeConfig(), backend, allowAll);
    expect(tool.name).toBe('computer');
    expect(tool.executionMode).toBe('sequential');
    expect(tool.description).toMatch(/Always screenshot first/);
    expect(tool.description).toMatch(/VERIFICACION/);
  });

  it('normalizeAction rescata llamadas filtradas como texto', () => {
    expect(
      normalizeAction(
        '<|tool_call|>{"name":"computer","arguments":{"action":"click","x":113,"y":175}}</tool_call>',
      ),
    ).toEqual({ action: 'click', x: 113, y: 175, button: 'left', clicks: 1 });
    expect(normalizeAction('{"type":"key","key":"enter"}')).toEqual({
      action: 'key',
      key: 'enter',
    });
    expect(normalizeAction('{"action":"type","text":"x","secret":true}')).toEqual({
      action: 'type',
      text: 'x',
      secret: true,
    });
    expect(normalizeAction('sin json')).toBeNull();
    expect(normalizeAction('{"action":"rm"}')).toBeNull();
  });
});
