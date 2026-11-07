import { describe, expect, it } from 'vitest';
import { WdaClient } from '../src/iphone/wda.js';
import { elementosWda, resumirArbolWda } from '../src/iphone/wda-texto.js';
import { createIphonePantallaTool } from '../src/tools/iphone-pantalla.js';

// Un trozo de Ajustes como lo da WDA con /source?format=json (forma de dictionaryForElement).
const n = (
  type: string,
  rect: [number, number, number, number],
  extra: Record<string, unknown> = {},
  children: unknown[] = [],
) => ({
  type,
  label: null,
  name: null,
  value: null,
  rect: { x: rect[0], y: rect[1], width: rect[2], height: rect[3] },
  isEnabled: '1',
  isVisible: '1',
  ...extra,
  ...(children.length ? { children } : {}),
});

const AJUSTES = n('Application', [0, 0, 402, 874], { label: 'Ajustes', name: 'Ajustes' }, [
  n('Window', [0, 0, 402, 874], {}, [
    n('Other', [0, 0, 402, 874], {}, [
      n('NavigationBar', [0, 50, 402, 44], { name: 'Ajustes' }, [
        n('StaticText', [160, 60, 82, 24], { label: 'Ajustes', name: 'Ajustes' }),
      ]),
      n('Cell', [0, 200, 402, 44], { label: 'Wi-Fi', name: 'Wi-Fi', value: 'Casa' }, [
        n('StaticText', [60, 210, 60, 24], { label: 'Wi-Fi', name: 'Wi-Fi', value: 'Wi-Fi' }),
      ]),
      n('Switch', [330, 250, 51, 31], { label: 'Modo Avión', name: 'Modo Avión', value: '0' }),
      n('Button', [16, 300, 100, 40], { label: 'Oculto', isVisible: '0' }),
      n('Button', [16, 350, 100, 40], { label: 'Borrar', isEnabled: '0' }),
      n('Other', [0, 400, 402, 300]),
    ]),
  ]),
]);

describe('resumen del árbol de WebDriverAgent (idea de phoneuse: la pantalla en texto)', () => {
  it('una línea por elemento con texto, centro en puntos, sin cajas vacías ni ocultos', () => {
    const e = elementosWda(AJUSTES);
    expect(e.map((x) => `${x.tipo} ${x.texto}`)).toEqual([
      'StaticText Ajustes',
      'Cell Wi-Fi',
      'Switch Modo Avión',
      'Button Borrar',
    ]);
    expect(e.find((x) => x.tipo === 'Cell')).toMatchObject({ x: 201, y: 222, valor: 'Casa' });
  });

  it('interruptores = sí/no y desactivados marcados', () => {
    const s = resumirArbolWda(AJUSTES) ?? '';
    expect(s).toMatch(/356 266 {2}Switch «Modo Avión» = no/);
    expect(s).toMatch(/Button «Borrar» \(desactivado\)/);
    expect(s).not.toMatch(/Oculto/);
    expect(s).toMatch(/en puntos/);
  });

  it('recorta y lo dice; algo que no es el árbol da null', () => {
    expect(resumirArbolWda(AJUSTES, 2)).toMatch(/2 elementos más no se muestran/);
    expect(resumirArbolWda('Button "Enviar" {{300, 700}, {80, 40}}')).toBeNull();
    expect(resumirArbolWda(null)).toBeNull();
  });
});

function wda(source: (path: string) => unknown) {
  const pedidas: string[] = [];
  const f = async (url: string) => {
    const path = url.replace('http://wda', '');
    pedidas.push(path);
    return { ok: true, status: 200, text: async () => JSON.stringify({ value: source(path) }) };
  };
  return { pedidas, cliente: new WdaClient({ baseUrl: 'http://wda', fetch: f as never }) };
}

describe('iphone_pantalla leer', () => {
  it('pide el JSON y devuelve el resumen, no el volcado', async () => {
    const { pedidas, cliente } = wda(() => AJUSTES);
    const tool = createIphonePantallaTool(() => cliente);
    const r = await tool.execute('t', { action: 'leer' } as never);
    const texto = (r.content[0] as { text: string }).text;
    expect(pedidas).toEqual(['/source?format=json']);
    expect(texto).toMatch(/Cell «Wi-Fi» = Casa/);
    expect(texto).not.toMatch(/"rect"/);
  });

  it('un WDA sin JSON útil cae al árbol de siempre; crudo=true lo pide directo', async () => {
    const { pedidas, cliente } = wda((p) =>
      p.includes('json') ? 'no json' : 'Button "Enviar" {{300, 700}, {80, 40}}',
    );
    const tool = createIphonePantallaTool(() => cliente);
    const r = await tool.execute('t', { action: 'leer' } as never);
    expect((r.content[0] as { text: string }).text).toContain('Enviar');
    await tool.execute('t', { action: 'leer', crudo: true } as never);
    expect(pedidas).toEqual([
      '/source?format=json',
      '/source?format=description',
      '/source?format=description',
    ]);
  });
});
