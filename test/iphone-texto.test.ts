import { describe, expect, it } from 'vitest';
import { formatearPantalla, lineasDePantalla, pantallaBloqueada } from '../src/iphone/texto.js';
import { Gate } from '../src/permissions.js';
import { ocrCapturaIphone } from '../src/plugins/iphone.js';
import type { OcrResult } from '../src/screen/ocr.js';
import { createIphoneTool, type IphoneToolDeps } from '../src/tools/iphone.js';

// Una captura de 400x800 px: cada línea es una caja en píxeles, como la da el OCR de Windows.
function ocr(lineas: [string, number, number, number?, number?][]): OcrResult {
  return {
    width: 400,
    height: 800,
    language: 'es-ES',
    text: lineas.map((l) => l[0]).join('\n'),
    lines: lineas.map(([text, x, y, width = 80, height = 20]) => ({
      text,
      x,
      y,
      width,
      height,
      words: [],
    })),
  };
}

const AJUSTES = ocr([
  ['19:04', 20, 10, 50, 20], // barra de estado
  ['<', 10, 60, 16, 20], // flecha de volver
  ['Ajustes', 160, 60],
  ['Wi-Fi', 60, 200],
  ['Casa', 300, 200],
  ['Bluetooth', 60, 260],
  ['>', 370, 260, 10, 20], // un icono que el OCR lee como signo
]);

describe('lineasDePantalla (idea de phoneuse)', () => {
  it('pasa a fracciones del centro, quita la barra de estado y los signos sueltos y marca [atrás]', () => {
    const l = lineasDePantalla(AJUSTES);
    expect(l.map((x) => x.texto)).toEqual(['[atrás]', 'Ajustes', 'Wi-Fi', 'Casa', 'Bluetooth']);
    const wifi = l.find((x) => x.texto === 'Wi-Fi');
    expect(wifi).toEqual({ texto: 'Wi-Fi', x: 0.25, y: 0.263 });
  });

  it('ordena por filas y, en la misma fila, de izquierda a derecha', () => {
    const l = lineasDePantalla(
      ocr([
        ['derecha', 300, 400],
        ['abajo', 10, 600],
        ['izquierda', 10, 402],
      ]),
    );
    expect(l.map((x) => x.texto)).toEqual(['izquierda', 'derecha', 'abajo']);
  });

  it('todo=true deja la barra de estado', () => {
    expect(lineasDePantalla(AJUSTES, { todo: true }).map((x) => x.texto)).toContain('19:04');
  });

  it('formatearPantalla: «x y  texto» y explica que esas x y sirven para tocar', () => {
    const s = formatearPantalla(lineasDePantalla(AJUSTES));
    expect(s).toMatch(/0\.250 0\.263 {2}Wi-Fi/);
    expect(s).toMatch(/fracciones/);
    expect(formatearPantalla([])).toMatch(/No sale texto/);
  });

  it('formatearPantalla avisa cuando recorta', () => {
    const muchas = Array.from({ length: 5 }, (_, i) => ({ texto: `l${i}`, x: 0.5, y: i / 10 }));
    expect(formatearPantalla(muchas, 2)).toMatch(/3 líneas más no se muestran/);
  });
});

describe('pantallaBloqueada', () => {
  it('reconoce el código y la pantalla de bloqueo (fecha encima del reloj), en castellano e inglés', () => {
    expect(pantallaBloqueada(lineasDePantalla(ocr([['Introduce el código', 100, 200, 200]])))).toBe(
      true,
    );
    expect(
      pantallaBloqueada(
        lineasDePantalla(
          ocr([
            ['Emergencia', 20, 700],
            ['Cancelar', 300, 700],
          ]),
        ),
      ),
    ).toBe(true);
    expect(
      pantallaBloqueada(
        lineasDePantalla(
          ocr([
            ['sábado, 7 de noviembre', 100, 90, 200, 20],
            ['19:04', 120, 130, 160, 80],
          ]),
          { todo: true },
        ),
      ),
    ).toBe(true);
    expect(pantallaBloqueada(lineasDePantalla(ocr([['Enter Passcode', 100, 200]])))).toBe(true);
  });

  it('una pantalla normal no está bloqueada (ni un reloj sin fecha)', () => {
    expect(pantallaBloqueada(lineasDePantalla(AJUSTES, { todo: true }))).toBe(false);
    expect(pantallaBloqueada(lineasDePantalla(ocr([['19:04', 120, 130, 160, 80]])))).toBe(false);
  });
});

function tool(over: Partial<IphoneToolDeps> = {}) {
  const deps: IphoneToolDeps = {
    status: async () => {
      throw new Error('no');
    },
    frame: async () => Buffer.from([0xff, 0xd8, 0xff, 1]),
    start: async () => undefined,
    stop: async () => undefined,
    home: async () => undefined,
    ...over,
  };
  const t = createIphoneTool(deps);
  return (args: Record<string, unknown>) =>
    t.execute('t', args as never) as unknown as Promise<{
      content: { type: string; text?: string }[];
      details: Record<string, unknown>;
    }>;
}

describe('tool iphone, action=texto', () => {
  it('lee la captura con el OCR y devuelve texto, sin imagen', async () => {
    let visto: Buffer | null = null;
    const run = tool({
      ocr: async (jpeg) => {
        visto = jpeg;
        return AJUSTES;
      },
    });
    const r = await run({ action: 'texto' });
    expect(visto).not.toBeNull();
    expect(r.content).toHaveLength(1);
    expect(r.content[0]?.type).toBe('text');
    expect(r.content[0]?.text).toMatch(/Wi-Fi/);
    expect(r.details).toEqual({ lineas: 5, bloqueado: false });
  });

  it('avisa en cabeza si el teléfono está bloqueado', async () => {
    const run = tool({ ocr: async () => ocr([['Introduce el código', 100, 200, 200]]) });
    const r = await run({ action: 'texto' });
    expect(r.content[0]?.text).toMatch(/^AVISO: el iPhone esta BLOQUEADO/);
    expect(r.details.bloqueado).toBe(true);
  });

  it('sin OCR lo dice y remite a screenshot', async () => {
    await expect(tool()({ action: 'texto' })).rejects.toThrow(/action=screenshot/);
  });

  it('es una lectura para la Gate (como screenshot)', () => {
    const gate = new Gate({ allowUntilPayment: true, approver: () => true });
    expect(gate.classifyEffect({ tool: 'iphone', args: { action: 'texto' }, actor: 'test' })).toBe(
      'lee',
    );
  });
});

describe('ocrCapturaIphone (OCR de Windows sobre la captura)', () => {
  it('fuera de Windows lo dice claro', async () => {
    await expect(ocrCapturaIphone(Buffer.from([1]), 'linux')).rejects.toThrow(/no es Windows/);
  });

  it('en Windows escribe un temporal, lo lee y lo borra aunque el OCR falle', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    let ruta = '';
    const r = await ocrCapturaIphone(Buffer.from([9, 9]), 'win32', async (p) => {
      ruta = p;
      expect(readFileSync(p)).toEqual(Buffer.from([9, 9]));
      return AJUSTES;
    });
    expect(r).toBe(AJUSTES);
    expect(existsSync(ruta)).toBe(false);
    await expect(
      ocrCapturaIphone(Buffer.from([1]), 'win32', async (p) => {
        ruta = p;
        throw new Error('ocr roto');
      }),
    ).rejects.toThrow('ocr roto');
    expect(existsSync(ruta)).toBe(false);
  });
});
