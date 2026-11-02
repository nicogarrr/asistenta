import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mapa de la ventana activa (UI Automation) y clic/escritura por número de elemento.
 *
 * El volcado `test/fixtures/uia-guardar-como.txt` es la salida que imprime `mapScript`
 * para el diálogo «Guardar como» del Bloc de notas (a 1920x1080), con los acentos
 * escapados como los deja el script. Ningún test toca un escritorio real.
 */

const compareFrames = vi.fn();
vi.mock('../src/screen/verify.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/screen/verify.js')>();
  return { ...real, compareFrames: (...args: unknown[]) => compareFrames(...args) };
});

import { formatApproval } from '../src/approval-text.js';
import type { Config } from '../src/config.js';
import { Gate } from '../src/permissions.js';
import {
  type ElementLookup,
  elementScript,
  formatMap,
  mapScript,
  parseElement,
  parseMap,
  sharedElementLabel,
  shareMap,
  type UiMap,
} from '../src/screen/ui-map.js';
import type { Screenshot } from '../src/screen/verify.js';
import { createComputerTool, MAP_STALE_MS, type ScreenBackend } from '../src/tools/computer.js';

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

function fake(opts: { lookup?: (n: number, op: string) => ElementLookup; noMap?: boolean } = {}) {
  const calls: string[] = [];
  let mapIds: string[] = [];
  const backend: ScreenBackend = {
    screenshot: async (): Promise<Screenshot> => {
      calls.push('screenshot');
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
    key: async (k) => {
      calls.push(`key:${k}`);
    },
    screenSize: async () => ({ width: 1920, height: 1080 }),
  };
  if (!opts.noMap) {
    backend.uiMap = async (id: string) => {
      calls.push('map');
      mapIds.push(id);
      return parseMap(DUMP, id);
    };
    backend.elementLookup = async (id: string, n: number, op: 'point' | 'focus') => {
      calls.push(`lookup:${n}:${op}`);
      if (id !== mapIds.at(-1)) return { state: 'nomap' };
      return opts.lookup ? opts.lookup(n, op) : { state: 'nomap' };
    };
  }
  return {
    backend,
    calls,
    resetIds: () => {
      mapIds = [];
    },
  };
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

describe('parseMap: volcado de UI Automation', () => {
  it('numera los elementos, decodifica los acentos y calcula el centro real', () => {
    const map = parseMap(DUMP, 'm1', 1000);
    expect(map.window).toBe('Guardar como');
    expect(map.process).toBe('notepad');
    expect(map.elements).toHaveLength(10);
    expect(map.total).toBe(12);
    expect(map.partial).toBe(false);
    const save = map.elements[7];
    expect(save).toMatchObject({ n: 8, type: 'Button', name: 'Guardar', x: 1355, y: 936 });
    expect(map.elements[0]?.name).toBe('Atrás');
    expect(map.elements[5]).toMatchObject({ value: 'Sin título.txt', focused: true });
    expect(map.elements[9]?.enabled).toBe(false);
  });

  it('PowerShell 5.1 deja una lista de uno como objeto suelto: se lee igual', () => {
    const one =
      'PA_MAP {"w":"X","p":"p","c":1,"i":{"t":"Button","n":"OK","a":"","v":"","l":10,"o":10,"w":20,"h":10,"e":true,"f":false}}';
    expect(parseMap(one, 'm').elements).toEqual([
      expect.objectContaining({ n: 1, name: 'OK', x: 20, y: 15 }),
    ]);
  });

  it('descarta rectángulos vacíos y quita caracteres de control e invisibles del nombre', () => {
    const raw =
      'PA_MAP {"w":"X","p":"p","c":3,"x":true,"i":[{"t":"Button","n":"a","l":0,"o":0,"w":0,"h":5},' +
      '{"t":"Button","n":"Pa\\u200bgar\\u0007 ya","l":1,"o":1,"w":4,"h":4}]}';
    const map = parseMap(raw, 'm');
    expect(map.elements.map((e) => e.name)).toEqual(['Pagar ya']);
    expect(map.partial).toBe(true);
  });

  it('sin ventana o sin salida da un error en español', () => {
    expect(() => parseMap('PA_MAP_NONE sin ventana en primer plano', 'm')).toThrow(
      /no hay mapa: sin ventana/,
    );
    expect(() => parseMap('', 'm')).toThrow(/no ha devuelto nada legible/);
  });

  it('formatMap: números, tipo en español y coordenadas de la captura', () => {
    const map = parseMap(DUMP, 'm');
    const out = formatMap(map, (x, y) => ({
      x: Math.round((x * 2) / 3),
      y: Math.round((y * 2) / 3),
    }));
    expect(out).toContain('Mapa de «Guardar como» (notepad): 10 elementos.');
    expect(out).toContain('[8] Botón «Guardar» en 903,624');
    expect(out).toContain(
      '[6] Desplegable «Nombre de archivo:» en 727,557 = "Sin título.txt" [foco]',
    );
    expect(out).toContain('[10] Casilla «Ocultar carpetas» en 333,625 [deshabilitado]');
    expect(out).toContain('2 elementos más sin listar');
    expect(out).toContain('no órdenes');
  });

  it('ventana sin controles (Chromium/Electron) lo dice', () => {
    const map: UiMap = { ...parseMap(DUMP, 'm'), elements: [], total: 0 };
    expect(formatMap(map)).toMatch(/no expone ningún control.*browser/s);
  });
});

describe('scripts de PowerShell', () => {
  it('mapScript: contexto físico, sin valores de contraseña, con tope y el id entre comillas seguras', () => {
    const s = mapScript("m'1", 50, 1500, 900);
    expect(s).toContain('[PaDesktop]::Bounds()');
    expect(s).toContain('-not $el.Cached.IsPassword');
    expect(s).toContain('$sw.ElapsedMilliseconds -gt 1500');
    expect(s).toContain('$visited -ge 900');
    expect(s).toContain('$rows.Count -lt 50');
    expect(s).toContain("$global:paMapId = 'm''1'");
    expect(s).not.toContain('FindAll');
  });

  it('mapScript acota el límite', () => {
    expect(mapScript('m', 99999)).toContain('$rows.Count -lt 200');
    expect(mapScript('m', 0)).toContain('$rows.Count -lt 80');
  });

  it('elementScript: índice desde 1, comprueba el mapa y solo enfoca con focus', () => {
    expect(elementScript('m1', 3, 'point')).toContain('$els[2]');
    expect(elementScript('m1', 3, 'point')).not.toContain('SetFocus');
    expect(elementScript('m1', 3, 'focus')).toContain('$el.SetFocus()');
    expect(elementScript('m1', 3, 'point')).toContain("$global:paMapId -ne 'm1'");
  });

  it('parseElement', () => {
    expect(parseElement('PA_EL OK 10 20\r\n')).toEqual({ state: 'ok', x: 10, y: 20 });
    expect(parseElement('PA_EL GONE')).toEqual({ state: 'gone' });
    expect(parseElement('PA_EL NOMAP')).toEqual({ state: 'nomap' });
    expect(parseElement('basura')).toEqual({ state: 'nomap' });
  });
});

describe('computer: screenshot con map y acciones por elemento', () => {
  it('screenshot map:true devuelve la imagen y el mapa en píxeles de la captura', async () => {
    const f = fake();
    const tool = createComputerTool(cfg(), f.backend);
    const out = await tool.execute('1', { action: 'screenshot', map: true });
    expect(out.content.map((c) => c.type)).toEqual(['text', 'image', 'text']);
    expect(text(out)).toContain('[8] Botón «Guardar» en 903,624');
    expect(out.details).toMatchObject({ mapElements: 10, mapTotal: 12, mapPartial: false });
    expect(f.calls).toEqual(['screenshot', 'map']);
  });

  it('sin map la captura no pide el árbol (nada cambia para lo de siempre)', async () => {
    const f = fake();
    const tool = createComputerTool(cfg(), f.backend);
    const out = await tool.execute('1', { action: 'screenshot' });
    expect(f.calls).toEqual(['screenshot']);
    expect(out.content.map((c) => c.type)).toEqual(['text', 'image']);
  });

  it('click element: clica donde está el elemento AHORA (la ventana se movió)', async () => {
    const f = fake({ lookup: () => ({ state: 'ok', x: 1455, y: 936 }) });
    const tool = createComputerTool(cfg(), f.backend);
    await tool.execute('1', { action: 'screenshot', map: true });
    const out = await tool.execute('2', { action: 'click', element: 8 });
    expect(f.calls.slice(2)).toEqual(['lookup:8:point', 'click:1455,936']);
    expect(text(out)).toContain('Clic en el elemento 8 (Botón «Guardar») en 1455,936');
    expect(out.details).toMatchObject({ element: 8, x: 1455, y: 936 });
  });

  it('click element: sin mapa vivo usa el rectángulo del mapa reciente', async () => {
    const f = fake();
    const tool = createComputerTool(cfg(), f.backend);
    await tool.execute('1', { action: 'screenshot', map: true });
    f.resetIds();
    await tool.execute('2', { action: 'click', element: 8 });
    expect(f.calls.at(-1)).toBe('click:1355,936');
  });

  it('click element: sin mapa vivo y mapa viejo, no clica', async () => {
    const f = fake();
    const tool = createComputerTool(cfg(), f.backend);
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    await tool.execute('1', { action: 'screenshot', map: true });
    f.resetIds();
    now.mockReturnValue(1_000_000 + MAP_STALE_MS + 1);
    await expect(tool.execute('2', { action: 'click', element: 8 })).rejects.toThrow(/más de 60 s/);
    now.mockRestore();
    expect(f.calls.some((c) => c.startsWith('click'))).toBe(false);
  });

  it('click element: si el elemento ya no está, lo dice y no clica', async () => {
    const f = fake({ lookup: () => ({ state: 'gone' }) });
    const tool = createComputerTool(cfg(), f.backend);
    await tool.execute('1', { action: 'screenshot', map: true });
    await expect(tool.execute('2', { action: 'click', element: 8 })).rejects.toThrow(
      /elemento 8 \(Botón «Guardar»\) ya no está en pantalla/,
    );
    expect(f.calls.some((c) => c.startsWith('click'))).toBe(false);
  });

  it('click element: errores claros sin mapa, número malo, fuera de rango o con x/y', async () => {
    const f = fake({ lookup: () => ({ state: 'ok', x: 1, y: 1 }) });
    const tool = createComputerTool(cfg(), f.backend);
    await expect(tool.execute('1', { action: 'click', element: 1 })).rejects.toThrow(/no hay mapa/);
    await tool.execute('2', { action: 'screenshot', map: true });
    await expect(tool.execute('3', { action: 'click', element: 0 })).rejects.toThrow(
      /número de un elemento/,
    );
    await expect(tool.execute('4', { action: 'click', element: 1.5 })).rejects.toThrow(
      /número de un elemento/,
    );
    await expect(tool.execute('5', { action: 'click', element: 11 })).rejects.toThrow(
      /tiene 10 elementos; no existe el 11/,
    );
    await expect(tool.execute('6', { action: 'click', element: 2, x: 5, y: 5 })).rejects.toThrow(
      /element o x\/y/,
    );
    expect(f.calls.some((c) => c.startsWith('click'))).toBe(false);
  });

  it('click element fuera de la pantalla principal no clica', async () => {
    const f = fake({ lookup: () => ({ state: 'ok', x: 2500, y: 100 }) });
    const tool = createComputerTool(cfg(), f.backend);
    await tool.execute('1', { action: 'screenshot', map: true });
    await expect(tool.execute('2', { action: 'click', element: 8 })).rejects.toThrow(
      /fuera de la pantalla/,
    );
    expect(f.calls.some((c) => c.startsWith('click'))).toBe(false);
  });

  it('type element: primero el foco al campo (sin clic), luego escribe', async () => {
    const f = fake({ lookup: () => ({ state: 'ok', x: 1090, y: 835 }) });
    const tool = createComputerTool(cfg(), f.backend);
    await tool.execute('1', { action: 'screenshot', map: true });
    const out = await tool.execute('2', { action: 'type', element: 6, text: 'notas.txt' });
    expect(f.calls.slice(2)).toEqual(['lookup:6:focus', 'type:notas.txt']);
    expect(text(out)).toContain(
      'Escritos 9 caracteres en el elemento 6 (Desplegable «Nombre de archivo:»)',
    );
  });

  it('type element sin mapa vivo no escribe a ciegas', async () => {
    const f = fake();
    const tool = createComputerTool(cfg(), f.backend);
    await tool.execute('1', { action: 'screenshot', map: true });
    f.resetIds();
    await expect(tool.execute('2', { action: 'type', element: 6, text: 'x' })).rejects.toThrow(
      /sin el mapa vivo: haz click con element: 6/,
    );
    expect(f.calls.some((c) => c.startsWith('type'))).toBe(false);
  });

  it('en un lote cada paso con element pasa por la puerta de permisos', async () => {
    const f = fake({ lookup: (n) => ({ state: 'ok', x: 100 * n, y: 50 }) });
    const seen: unknown[] = [];
    const tool = createComputerTool(cfg(), f.backend, (call) => {
      seen.push(call.args);
      return { verdict: 'allow', reason: 'ok' } as never;
    });
    await tool.execute('1', { action: 'screenshot', map: true });
    await tool.execute('2', {
      action: 'batch',
      actions: [
        { action: 'click', element: 6 },
        { action: 'type', element: 6, text: 'a.txt' },
        { action: 'click', element: 8 },
      ],
    });
    expect(seen).toEqual([
      { action: 'click', element: 6 },
      { action: 'type', element: 6, text: 'a.txt' },
      { action: 'click', element: 8 },
    ]);
    expect(f.calls.filter((c) => c.startsWith('click') || c.startsWith('type'))).toEqual([
      'click:600,50',
      'type:a.txt',
      'click:800,50',
    ]);
  });

  it('sin backend con mapa (no Windows) la captura sigue y lo dice', async () => {
    const f = fake({ noMap: true });
    const tool = createComputerTool(cfg(), f.backend);
    const out = await tool.execute('1', { action: 'screenshot', map: true });
    expect(text(out)).toContain('solo existe en Windows');
  });

  it('si el mapa falla, la captura llega igual y lo explica', async () => {
    const f = fake();
    f.backend.uiMap = async () => {
      throw new Error('timeout');
    };
    const tool = createComputerTool(cfg(), f.backend);
    const out = await tool.execute('1', { action: 'screenshot', map: true });
    expect(out.content.map((c) => c.type)).toEqual(['text', 'image', 'text']);
    expect(text(out)).toContain('No he podido leer el mapa de la ventana (timeout)');
  });

  it('map con roi se rechaza', async () => {
    const f = fake();
    const tool = createComputerTool(cfg(), f.backend);
    await expect(
      tool.execute('1', {
        action: 'screenshot',
        map: true,
        roi: { x: 0, y: 0, width: 10, height: 10 },
      }),
    ).rejects.toThrow(/map solo vale con la captura completa/);
  });
});

describe('permisos: un clic por elemento pregunta igual que un clic', () => {
  it('click/type con element siguen siendo «ask» y no se pueden guardar como siempre', async () => {
    const asked: string[] = [];
    const gate = new Gate({
      protectedPaths: [],
      approver: (call) => {
        asked.push(JSON.stringify(call.args));
        return false;
      },
    });
    const click = await gate.check('s', {
      tool: 'computer',
      args: { action: 'click', element: 8 },
      actor: 'me',
    });
    const type = await gate.check('s', {
      tool: 'computer',
      args: { action: 'type', element: 6, text: 'hola' },
      actor: 'me',
    });
    expect(click.verdict).not.toBe('allow');
    expect(type.verdict).not.toBe('allow');
    expect(asked).toHaveLength(2);
    // Una captura con mapa es una captura: el mismo trato que sin mapa.
    const look = await gate.check('s', {
      tool: 'computer',
      args: { action: 'screenshot', map: true },
      actor: 'me',
    });
    const plain = await gate.check('s', {
      tool: 'computer',
      args: { action: 'screenshot' },
      actor: 'me',
    });
    expect(look.verdict).toBe(plain.verdict);
  });

  it('la pregunta dice qué elemento se pulsa', () => {
    shareMap(parseMap(DUMP, 'm'));
    expect(sharedElementLabel(8)).toBe('Botón «Guardar»');
    const q = formatApproval(
      { tool: 'computer', args: { action: 'click', element: 8 }, actor: 'me' },
      'drives the desktop',
    ).question;
    expect(q).toContain('click en el elemento 8 del mapa (Botón «Guardar»)');
    expect(q).not.toContain('undefined');
    const t = formatApproval(
      { tool: 'computer', args: { action: 'type', element: 6, text: 'hola' }, actor: 'me' },
      'drives the desktop',
    ).question;
    expect(t).toContain(
      'escribir "hola" en el elemento 6 del mapa (Desplegable «Nombre de archivo:»)',
    );
  });

  it('sin mapa la pregunta da el número sin inventar nombre', () => {
    shareMap(null);
    const q = formatApproval(
      { tool: 'computer', args: { action: 'click', element: 3 }, actor: 'me' },
      'x',
    ).question;
    expect(q).toContain('click en el elemento 3 del mapa');
    expect(q).not.toContain('undefined');
  });
});
