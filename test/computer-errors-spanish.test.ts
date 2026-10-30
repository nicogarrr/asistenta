import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Los errores de la herramienta `computer` que lee el modelo están en español,
 * como el resto de sus líneas (#643). Antes: «coordinates … fall outside …»,
 * «this action requires numeric x and y», «unknown mouse button», «clicks must
 * be…», «the desktop changed from…», «Dragged …», «FAILED — …» y el aviso
 * bilingüe del interruptor. Solo cambia el texto: ningún error deja de saltar y
 * ninguna acción se ejecuta donde antes se negaba. Backend falso: nada toca un PC.
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

const ENGLISH =
  /\b(the|must|requires|unknown|outside|fall|Dragged|disabled|FAILED|got|screen\b|image you|retry)\b/;

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

async function rig(config: Partial<Config> = {}) {
  const f = fake();
  const tool = createComputerTool(makeConfig(config), f.backend, allowAll);
  await tool.execute('s', { action: 'screenshot' } as never);
  return { tool, ...f };
}

beforeEach(() => {
  compareFrames.mockReset();
});

describe('errores de computer en español', () => {
  it('coordenadas: no numéricas, fuera de la imagen y fuera de la roi', async () => {
    const { tool, calls } = await rig();
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ action: 'click', x: 'a', y: 1 }, /necesita x e y numéricas/],
      [{ action: 'click', x: 5000, y: 1 }, /quedan fuera de la imagen de 1280x720/],
      [
        { action: 'click', x: 200, y: 1, roi: { x: 0, y: 0, width: 100, height: 100 } },
        /quedan fuera de la roi de 100x100/,
      ],
      [
        { action: 'click', x: 1, y: 1, roi: 'mal' },
        /roi debe ser un objeto con x, y, width y height/,
      ],
    ];
    for (const [args, re] of cases) {
      const m = await said(tool, args);
      expect(m).toMatch(re);
      expect(m).not.toMatch(ENGLISH);
    }
    expect(calls.filter((c) => c !== 'screenshot')).toEqual([]);
  });

  it('botón, clicks, type, key, acción y lote', async () => {
    const { tool, calls } = await rig();
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [
        { action: 'click', x: 1, y: 1, button: 'double' },
        /botón del ratón desconocido "double": usa left, right o middle/,
      ],
      [
        { action: 'click', x: 1, y: 1, clicks: 9 },
        /clicks debe ser un número entero de 1 a 5; recibido 9/,
      ],
      [{ action: 'type', text: '' }, /la acción type necesita texto/],
      [{ action: 'key', key: '' }, /la acción key necesita el nombre de una tecla/],
      [{ action: 'volar' }, /acción desconocida: volar/],
      [{ action: 'batch', actions: [] }, /la acción batch necesita una lista actions no vacía/],
      [
        { action: 'batch', actions: [{ action: 'batch', actions: [] }] },
        /una acción dentro de un lote no puede ser otro lote/,
      ],
    ];
    for (const [args, re] of cases) {
      const m = await said(tool, args);
      expect(m).toMatch(re);
      expect(m).not.toMatch(ENGLISH);
    }
    expect(calls.filter((c) => c !== 'screenshot')).toEqual([]);
  });

  it('arrastre y pantalla cambiada', async () => {
    const { tool } = await rig();
    const drag = await said(tool, { action: 'drag', x: 100, y: 100, toX: 200, toY: 300 });
    expect(drag).toBe('Arrastre de 150,150 a 300,450');
    const f = fake({ native: { width: 1920, height: 1080 } });
    let native = { width: 1920, height: 1080 };
    f.backend.screenSize = async () => ({ ...native });
    const t2 = createComputerTool(makeConfig(), f.backend, allowAll);
    await t2.execute('s', { action: 'screenshot' } as never);
    native = { width: 2560, height: 1440 };
    const m = await said(t2, { action: 'click', x: 10, y: 10 });
    expect(m).toMatch(/la pantalla ha cambiado de 1920x1080 a 2560x1440.*captura nueva/);
    expect(m).not.toMatch(ENGLISH);
    const b = await said(t2, { action: 'batch', actions: [{ action: 'click', x: 10, y: 10 }] });
    expect(b).toMatch(/\[0\] click: FALLÓ — la pantalla ha cambiado/);
  });

  it('interruptor apagado: un solo aviso, en español', async () => {
    const f = fake();
    const tool = createComputerTool(makeConfig({ computerUse: false }), f.backend, allowAll);
    const m = await said(tool, { action: 'screenshot' });
    expect(m).toMatch(/desactivado en este PC \(PA_COMPUTER_USE=0\): no lo reintentes/);
    expect(m).toMatch(/quita esa línea del \.env y reinicia/);
    expect(m).not.toMatch(ENGLISH);
    expect(f.calls).toEqual([]);
  });
});
