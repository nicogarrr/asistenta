import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Set-of-Mark sobre la captura (números dibujados en cada elemento del mapa) y
 * `look` + `map`: la pantalla de después con su mapa nuevo en la misma llamada.
 * Todo con un backend falso; ningún test captura una pantalla real.
 */

const compareFrames = vi.fn();
vi.mock('../src/screen/verify.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/screen/verify.js')>();
  return { ...real, compareFrames: (...args: unknown[]) => compareFrames(...args) };
});

import type { Config } from '../src/config.js';
import { type MarkBox, marksScript, parseMap, shareMap } from '../src/screen/ui-map.js';
import type { Screenshot } from '../src/screen/verify.js';
import { captureScript } from '../src/screen/windows.js';
import { createComputerTool, type ScreenBackend } from '../src/tools/computer.js';

const DUMP = readFileSync(join(__dirname, 'fixtures', 'uia-guardar-como.txt'), 'utf8');

function cfg(over: Partial<Config> = {}): Config {
  return {
    screenshotMaxEdge: 1280,
    screenshotQuality: 80,
    verifyActions: false,
    verifySettleMs: 1,
    ...over,
  } as Config;
}

function fake() {
  const calls: string[] = [];
  const marksSeen: Array<readonly MarkBox[] | undefined> = [];
  let lastId = '';
  const backend: ScreenBackend = {
    screenshot: async (opts?: { marks?: readonly MarkBox[] }): Promise<Screenshot> => {
      calls.push(opts?.marks?.length ? `screenshot+marks:${opts.marks.length}` : 'screenshot');
      marksSeen.push(opts?.marks);
      return {
        image: Buffer.from('frame'),
        mimeType: 'image/jpeg',
        width: 1280,
        height: 720,
        nativeWidth: 1920,
        nativeHeight: 1080,
      };
    },
    click: async (x, y) => {
      calls.push(`click:${x},${y}`);
    },
    move: async () => {},
    drag: async () => {},
    type: async (t) => {
      calls.push(`type:${t}`);
    },
    key: async () => {},
    screenSize: async () => ({ width: 1920, height: 1080 }),
    uiMap: async (id: string) => {
      calls.push('map');
      lastId = id;
      return parseMap(DUMP, id);
    },
    elementLookup: async (id: string, n: number) => {
      if (id !== lastId) return { state: 'nomap' };
      return { state: 'ok', x: 100 * n, y: 60 };
    },
  };
  return { backend, calls, marksSeen };
}

function text(out: { content: Array<{ type: string; text?: string }> }): string {
  return out.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

beforeEach(() => {
  compareFrames.mockReset();
  shareMap(null);
});

describe('marksScript', () => {
  it('una caja por elemento, desplazada al monitor y con grosor/letra según la reducción', () => {
    const s = marksScript([
      { n: 1, left: 10, top: 20, width: 30, height: 40 },
      { n: 12, left: 100, top: 200, width: 0, height: 5 },
    ]);
    expect(s).toContain('[void]$marks.Add(@(1,10,20,30,40))');
    expect(s).toContain('[void]$marks.Add(@(12,100,200,1,5))');
    expect(s).toContain('$x = $m[1] - $b[0]; $y = $m[2] - $b[1]');
    expect(s).toContain('$k = 1.0 / $scale');
    expect(s).toContain('$gm.Dispose()');
  });

  it('sin marcas no añade nada y descarta valores no numéricos', () => {
    expect(marksScript([])).toBe('');
    expect(marksScript([{ n: Number.NaN, left: 1, top: 1, width: 1, height: 1 }])).toBe('');
  });

  it('captureScript dibuja después de copiar la pantalla y antes de reducir', () => {
    const s = captureScript('C:\\t\\a.jpg', 1280, [{ n: 3, left: 5, top: 6, width: 7, height: 8 }]);
    const copy = s.indexOf('CopyFromScreen');
    const draw = s.indexOf('[void]$marks.Add(@(3,5,6,7,8))');
    const shrink = s.indexOf('if ($scale -lt 1.0)');
    expect(copy).toBeGreaterThan(0);
    expect(draw).toBeGreaterThan(copy);
    expect(shrink).toBeGreaterThan(draw);
    expect(captureScript('C:\\t\\a.jpg', 1280)).not.toContain('$marks');
  });
});

describe('computer: marcas en la captura con map', () => {
  it('screenshot map:true pide el mapa primero y dibuja sus 10 números', async () => {
    const f = fake();
    const tool = createComputerTool(cfg(), f.backend);
    const out = await tool.execute('1', { action: 'screenshot', map: true });
    expect(f.calls).toEqual(['map', 'screenshot+marks:10']);
    expect(f.marksSeen[0]?.[7]).toEqual({ n: 8, left: 1300, top: 920, width: 110, height: 32 });
    expect(text(out)).toContain('Cada número está dibujado sobre su elemento');
    expect(out.details).toMatchObject({ marks: true });
  });

  it('la captura que va al chat sale limpia', async () => {
    const f = fake();
    const tool = createComputerTool(cfg(), f.backend, undefined, async () => true);
    await tool.execute('1', { action: 'screenshot', map: true, send: true });
    expect(f.calls).toEqual(['map', 'screenshot']);
  });

  it('PA_COMPUTER_MARKS=0: mapa sí, números dibujados no', async () => {
    const f = fake();
    const tool = createComputerTool(cfg({ computerMarks: false }), f.backend);
    const out = await tool.execute('1', { action: 'screenshot', map: true });
    expect(f.calls).toEqual(['map', 'screenshot']);
    expect(text(out)).toContain('[8] Botón «Guardar»');
    expect(text(out)).not.toContain('dibujado');
  });

  it('una captura normal no cambia: sin mapa ni marcas', async () => {
    const f = fake();
    const tool = createComputerTool(cfg(), f.backend);
    await tool.execute('1', { action: 'screenshot' });
    expect(f.calls).toEqual(['screenshot']);
  });
});

describe('computer: look + map', () => {
  it('click por elemento con look y map devuelve la pantalla de después con mapa nuevo', async () => {
    const f = fake();
    const tool = createComputerTool(cfg(), f.backend);
    await tool.execute('1', { action: 'screenshot', map: true });
    const out = await tool.execute('2', { action: 'click', element: 3, look: true, map: true });
    expect(f.calls.slice(2)).toEqual(['click:300,60', 'map', 'screenshot+marks:10']);
    expect(out.content.map((c) => c.type)).toEqual(['text', 'text', 'image', 'text']);
    expect(text(out)).toContain('Captura tras la acción');
    expect(text(out)).toContain('Mapa de «Guardar como»');
    // El mapa nuevo vale para el siguiente clic.
    await tool.execute('3', { action: 'click', element: 8 });
    expect(f.calls.at(-1)).toBe('click:800,60');
  });

  it('look sin map sigue como siempre (una captura, sin árbol)', async () => {
    const f = fake();
    const tool = createComputerTool(cfg(), f.backend);
    await tool.execute('1', { action: 'click', x: 10, y: 10, look: true });
    expect(f.calls).toEqual(['click:10,10', 'screenshot']);
  });

  it('un lote con look y map acaba con el mapa nuevo', async () => {
    const f = fake();
    const tool = createComputerTool(
      cfg(),
      f.backend,
      () => ({ verdict: 'allow', reason: 'ok' }) as never,
    );
    await tool.execute('1', { action: 'screenshot', map: true });
    const out = await tool.execute('2', {
      action: 'batch',
      look: true,
      map: true,
      actions: [
        { action: 'type', element: 6, text: 'notas.txt' },
        { action: 'click', element: 8 },
      ],
    });
    expect(f.calls.slice(2)).toEqual([
      'type:notas.txt',
      'click:800,60',
      'map',
      'screenshot+marks:10',
    ]);
    expect(text(out)).toContain('Mapa de «Guardar como»');
  });
});
