import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { shareView } from '../src/screen/ui-map.js';
import type { Screenshot } from '../src/screen/verify.js';
import { createComputerTool, type ScreenBackend } from '../src/tools/computer.js';
import { type ControlInfo, controlRows } from '../src/tools/windows.js';

/**
 * Clic desviado ×1,5 en 1920×1080: `windows controls` daba el centro de cada control en
 * píxeles REALES de pantalla, pero `computer.click` entiende x/y en píxeles de la última
 * captura (1280 px) y los vuelve a escalar. Un botón en 600,400 acababa clicado en
 * 900,600. Ahora `controls` da las coordenadas en el espacio de la última captura, las
 * mismas que usa el clic.
 */

const cfg = {
  screenshotMaxEdge: 1280,
  screenshotQuality: 80,
  verifyActions: false,
  verifySettleMs: 1,
} as Config;

const SAVE: ControlInfo = {
  name: 'Guardar',
  type: 'Button',
  automationId: '1',
  x: 600,
  y: 400,
  width: 90,
  height: 30,
  enabled: true,
  focused: false,
};

function backend(clicks: string[]): ScreenBackend {
  return {
    screenshot: async (): Promise<Screenshot> => ({
      image: Buffer.from('f'),
      mimeType: 'image/jpeg',
      width: 1280,
      height: 720,
      nativeWidth: 1920,
      nativeHeight: 1080,
    }),
    click: async (x, y) => {
      clicks.push(`${x},${y}`);
    },
    move: async () => {},
    drag: async () => {},
    type: async () => {},
    key: async () => {},
    screenSize: async () => ({ width: 1920, height: 1080 }),
  };
}

describe('windows controls + computer click en 1920×1080', () => {
  it('las coordenadas de controls, pasadas tal cual a click, caen en el control', async () => {
    shareView(null);
    const clicks: string[] = [];
    const tool = createComputerTool(cfg, backend(clicks));
    await tool.execute('1', { action: 'screenshot' });
    const { rows, note } = controlRows([SAVE]);
    expect(rows[0]).toContain('centro 400,267');
    expect(note).toContain('1280x720');
    const m = /centro (\d+),(\d+)/.exec(rows[0] ?? '');
    await tool.execute('2', { action: 'click', x: Number(m?.[1]), y: Number(m?.[2]) });
    expect(clicks).toEqual(['600,401']);
  });

  it('sin captura previa da píxeles reales y lo dice', () => {
    shareView(null);
    const { rows, note } = controlRows([SAVE]);
    expect(rows[0]).toContain('centro 600,400');
    expect(note).toMatch(/píxeles reales.*captura/);
  });

  it('a escala 1:1 no cambia nada', () => {
    shareView({ width: 1920, height: 1080, nativeWidth: 1920, nativeHeight: 1080 });
    expect(controlRows([SAVE]).rows[0]).toContain('centro 600,400 (90x30)');
    shareView(null);
  });
});
