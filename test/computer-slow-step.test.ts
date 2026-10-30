import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import type { Screenshot } from '../src/screen/verify.js';
import { createComputerTool, type ScreenBackend, SLOW_STEP_MS } from '../src/tools/computer.js';

/**
 * Paso lento. Con el PC cargado un paso de Computer Use puede tardar ~90 s y
 * Nico no veía nada. Ahora un paso de más de 10 s lo dice en su resultado para
 * que el modelo avise («Paso lento: 12 s»). Un paso normal no cambia.
 */
const config = {
  screenshotMaxEdge: 1280,
  screenshotQuality: 80,
  verifyActions: false,
  verifySettleMs: 1,
} as Config;

function backend(delayMs: number, failClick = false): ScreenBackend {
  const shot = async (): Promise<Screenshot> => ({
    image: Buffer.from('f'),
    mimeType: 'image/jpeg',
    width: 1280,
    height: 720,
    nativeWidth: 1280,
    nativeHeight: 720,
  });
  const slow = async () => {
    vi.setSystemTime(Date.now() + delayMs);
    if (failClick) throw new Error('clic roto');
  };
  return {
    screenshot: shot,
    screenSize: async () => ({ width: 1280, height: 720 }),
    click: slow,
    move: async () => {},
    drag: async () => {},
    type: async () => {},
    key: async () => {},
  } as unknown as ScreenBackend;
}

function texts(r: { content: Array<{ type: string; text?: string }> }): string {
  return r.content.map((c) => c.text ?? '').join('\n');
}

afterEach(() => vi.useRealTimers());

describe('computer · aviso de paso lento', () => {
  it('un clic de 12 s lleva la nota «Paso lento: 12 s»', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const tool = createComputerTool(config, backend(12_000));
    const r = await tool.execute('1', { action: 'click', x: 10, y: 10 } as never);
    expect(texts(r)).toContain('Clicked');
    expect(texts(r)).toContain('Paso lento: 12 s');
  });

  it('un clic rápido no cambia (caracterización)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const tool = createComputerTool(config, backend(50));
    const r = await tool.execute('1', { action: 'click', x: 10, y: 10 } as never);
    expect(texts(r)).not.toContain('Paso lento');
    expect(texts(r)).not.toContain('Slow step');
  });

  it('justo en el umbral no avisa; un error lento lleva la nota en el mensaje', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const r = await createComputerTool(config, backend(SLOW_STEP_MS)).execute('1', {
      action: 'click',
      x: 1,
      y: 1,
    } as never);
    expect(texts(r)).not.toContain('Paso lento');
    await expect(
      createComputerTool(config, backend(15_000, true)).execute('1', {
        action: 'click',
        x: 1,
        y: 1,
      } as never),
    ).rejects.toThrow(/clic roto[\s\S]*Paso lento: 15 s/);
  });
});
