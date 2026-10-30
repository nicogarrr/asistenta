import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Batch de escritorio cuando falla una captura de verificación (antes o después).
 * Base copiada de las pruebas de caracterización de `computer`.
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

describe('computer · batch cuando falla una captura de verificación', () => {
  it('si falla la captura POSTERIOR, devuelve el informe por acción (no lanza) y avisa de no repetir', async () => {
    // Capturas: 1 = base, 2 = posterior (rota).
    const { backend, calls } = fake({ failScreenshotAt: [2] });
    const tool = createComputerTool(makeConfig({ verifyActions: true }), backend, allowAll);
    // Antes: lanzaba «captura rota» después de haber escrito y pulsado; el modelo
    // solo veía el error y repetía el lote entero (texto escrito dos veces).
    const r = await tool.execute('b', {
      action: 'batch',
      actions: [
        { action: 'type', text: 'hola' },
        { action: 'key', key: 'enter' },
      ],
    });
    expect(calls).toEqual(['screenshot', 'type:hola', 'key:enter', 'screenshot']);
    const text = textOf(r);
    expect(text).toMatch(/^Lote de 2 acciones: 2 ok, 0 sin ejecutar\./);
    expect(text).toMatch(/\[0\] type: ok/);
    expect(text).toMatch(/\[1\] key: ok/);
    expect(text).toMatch(
      /no he podido comparar el lote: la captura posterior ha fallado \(captura rota\)/,
    );
    expect(text).toMatch(/no repitas el lote/);
    const details = r.details as { verified: unknown; verifyError?: string };
    expect(details.verified).toBeNull();
    expect(details.verifyError).toMatch(/posterior/);
    expect(compareFrames).not.toHaveBeenCalled();
  });

  it('si falla la captura PREVIA, el lote se ejecuta entero y dice que no se pudo comparar', async () => {
    const { backend, calls } = fake({ failScreenshotAt: [1] });
    const tool = createComputerTool(makeConfig({ verifyActions: true }), backend, allowAll);
    // Antes: la primera acción salía «FAILED — captura rota» sin ejecutarse y el
    // resto se saltaba: una captura inestable bloqueaba cualquier secuencia.
    const r = await tool.execute('b', {
      action: 'batch',
      actions: [
        { action: 'click', x: 10, y: 20 },
        { action: 'type', text: 'x' },
      ],
    });
    // Un solo intento de base (el fallido): sin reintentarla tras la primera acción
    // (compararía marcos equivocados) y sin captura posterior inútil.
    expect(calls).toEqual(['screenshot', 'click:10,20:left:1', 'type:x']);
    const text = textOf(r);
    expect(text).toMatch(/^Lote de 2 acciones: 2 ok, 0 sin ejecutar\./);
    expect(text).not.toMatch(/FALLÓ|FAILED/);
    expect(text).toMatch(
      /no he podido comparar el lote: la captura previa ha fallado \(captura rota\)/,
    );
    expect((r.details as { verified: unknown }).verified).toBeNull();
  });

  it('con las capturas bien, el lote sigue igual (caracterización: base → acciones → posterior)', async () => {
    compareFrames.mockResolvedValue({
      changed: true,
      changedFraction: 0.1,
      failed: false,
      reason: 'ok',
    });
    const { backend, calls } = fake();
    const tool = createComputerTool(makeConfig({ verifyActions: true }), backend, allowAll);
    const r = await tool.execute('b', {
      action: 'batch',
      actions: [{ action: 'type', text: 'a' }],
    });
    expect(calls).toEqual(['screenshot', 'type:a', 'screenshot']);
    expect(textOf(r)).not.toMatch(/no he podido comparar el lote/);
    expect((r.details as { verifyError?: string }).verifyError).toBeUndefined();
  });

  it('sin verificación no hay capturas ni aviso', async () => {
    const { backend, calls } = fake({ failScreenshotAt: [1, 2] });
    const tool = createComputerTool(makeConfig({ verifyActions: false }), backend, allowAll);
    const r = await tool.execute('b', {
      action: 'batch',
      actions: [{ action: 'key', key: 'tab' }],
    });
    expect(calls).toEqual(['key:tab']);
    expect(textOf(r)).not.toMatch(/VERIFICACION/);
  });
});
