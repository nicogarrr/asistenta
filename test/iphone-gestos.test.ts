import { describe, expect, it } from 'vitest';
import { type FetchLike, IphoneClient, type IphoneStatus } from '../src/iphone/client.js';
import {
  abrirApp,
  BloqueadoError,
  comboValido,
  desplazar,
  escribirTexto,
  type ManosIphone,
  nombreTecleable,
  problemaAlEscribir,
} from '../src/iphone/gestos.js';
import { buscarTexto, type LineaPantalla, zonaProhibida } from '../src/iphone/texto.js';
import { Gate } from '../src/permissions.js';
import { gestosActivados } from '../src/plugins/iphone.js';
import type { OcrResult } from '../src/screen/ocr.js';
import { createIphoneTool, type IphoneToolDeps } from '../src/tools/iphone.js';

const L = (texto: string, x: number, y: number): LineaPantalla => ({ texto, x, y });
const AJUSTES = [
  L('[atrás]', 0.05, 0.08),
  L('Ajustes', 0.5, 0.08),
  L('Wi-Fi', 0.25, 0.26),
  L('Bluetooth', 0.25, 0.33),
  L('Datos móviles', 0.3, 0.4),
  L('Datos de uso', 0.3, 0.47),
];

describe('buscarTexto (tocar por texto, idea de phoneuse)', () => {
  it('exacto, sin mayúsculas ni tildes y sin palabras de relleno', () => {
    const r = buscarTexto(AJUSTES, 'botón «wi-fi»');
    expect(r).toMatchObject({ ok: true, como: 'exacto', linea: { texto: 'Wi-Fi' } });
    expect(buscarTexto(AJUSTES, 'datos moviles')).toMatchObject({ ok: true, como: 'exacto' });
  });

  it('la única línea que empieza por el texto', () => {
    expect(buscarTexto(AJUSTES, 'Blue')).toMatchObject({ ok: true, como: 'empieza' });
  });

  it('dos que empiezan igual: no adivina', () => {
    const r = buscarTexto(AJUSTES, 'Datos');
    expect(r).toMatchObject({ ok: false, motivo: 'ambiguo' });
    expect(r.ok ? [] : r.candidatas).toHaveLength(2);
  });

  it('una letra mal leída por el OCR, sí; algo que no está, no', () => {
    expect(buscarTexto([L('Message', 0.5, 0.5)], 'iMessage')).toMatchObject({
      ok: true,
      como: 'parecido',
    });
    expect(buscarTexto(AJUSTES, 'Contraseñas')).toMatchObject({ ok: false, motivo: 'no-esta' });
    expect(buscarTexto(AJUSTES, 'el botón')).toMatchObject({ ok: false, motivo: 'vacio' });
  });

  it('nunca elige la barra de estado ni la flecha de volver', () => {
    expect(buscarTexto([L('19:04', 0.1, 0.02)], '19:04')).toMatchObject({ ok: false });
    expect(buscarTexto(AJUSTES, '[atrás]')).toMatchObject({ ok: false });
  });
});

describe('zonaProhibida', () => {
  it('la isla dinámica y lo que no son fracciones', () => {
    expect(zonaProhibida(0.5, 0.03)).toMatch(/isla dinámica/);
    expect(zonaProhibida(120, 300)).toMatch(/fracciones/);
    expect(zonaProhibida(Number.NaN, 0.5)).toMatch(/fracciones/);
    expect(zonaProhibida(0.1, 0.03)).toBeNull();
    expect(zonaProhibida(0.5, 0.5)).toBeNull();
  });
});

describe('escribir con el teclado de EE. UU. del puente', () => {
  it('rechaza eñes y tildes antes de mandar nada', () => {
    expect(problemaAlEscribir('hola que tal\n')).toBeNull();
    expect(problemaAlEscribir('mañana')).toMatch(/«ñ»/);
    expect(problemaAlEscribir('')).toMatch(/Falta/);
    expect(problemaAlEscribir('a'.repeat(501))).toMatch(/500/);
    expect(nombreTecleable('  Música ')).toBe('Musica');
  });

  it('combos que entiende el firmware', () => {
    for (const c of ['enter', 'cmd+a', 'shift+tab', 'CMD+H', 'backspace', '7'])
      expect(comboValido(c)).toBe(true);
    for (const c of ['', 'cmd+', 'f13', 'cmd+enter+x', 'rm -rf'])
      expect(comboValido(c)).toBe(false);
  });
});

function manos() {
  const calls: string[] = [];
  const m: ManosIphone & { back(): Promise<void> } = {
    tap: async (x, y) => void calls.push(`tap ${x} ${y}`),
    swipe: async (a, b, c, d) => void calls.push(`swipe ${a} ${b} ${c} ${d}`),
    type: async (t) => void calls.push(`type ${t}`),
    key: async (k) => void calls.push(`key ${k}`),
    back: async () => void calls.push('back'),
  };
  return { m, calls };
}
const nada = async () => undefined;
const BLOQUEO = [L('Introduce el código', 0.5, 0.3)];

describe('recetas', () => {
  it('abrir una app: Inicio, buscar, el nombre sin tildes e Intro', async () => {
    const { m, calls } = manos();
    await abrirApp(m, async () => AJUSTES, 'Música', nada);
    expect(calls).toEqual(['key cmd+h', 'key cmd+space', 'type Musica', 'key enter']);
  });

  it('abrir una app con el móvil bloqueado: tras Cmd+H se para y no escribe nada', async () => {
    const { m, calls } = manos();
    await expect(abrirApp(m, async () => BLOQUEO, 'WhatsApp', nada)).rejects.toBeInstanceOf(
      BloqueadoError,
    );
    expect(calls).toEqual(['key cmd+h']);
  });

  it('escribir: Intro por cada salto de línea; sin OCR no escribe', async () => {
    const { m, calls } = manos();
    await escribirTexto(m, async () => AJUSTES, 'hola\nadios');
    expect(calls).toEqual(['type hola', 'key enter', 'type adios']);
    const otra = manos();
    await expect(escribirTexto(otra.m, async () => null, 'hola')).rejects.toThrow(/no escribo/);
    expect(otra.calls).toEqual([]);
  });

  it('desplazar arrastra por el centro sin llegar a los bordes', async () => {
    const { m, calls } = manos();
    await desplazar(m, 'abajo');
    await desplazar(m, 'arriba', 2);
    expect(calls).toEqual(['swipe 0.5 0.7 0.5 0.3', 'swipe 0.5 0.3 0.5 0.92']);
  });
});

const READY: IphoneStatus = {
  device: true,
  screen: true,
  calibrated: true,
  models: { planner: 'p', actor: 'a' },
  agent: { running: false, task: null, steps: 0 },
};

// El OCR de prueba devuelve las líneas en píxeles de una captura de 1000x1000.
function ocrDe(lineas: LineaPantalla[]): OcrResult {
  return {
    width: 1000,
    height: 1000,
    language: 'es-ES',
    text: '',
    lines: lineas.map((l) => ({
      text: l.texto === '[atrás]' ? '<' : l.texto,
      x: l.x * 1000 - 10,
      y: l.y * 1000 - 5,
      width: 20,
      height: 10,
      words: [],
    })),
  };
}

function tool(over: Partial<IphoneToolDeps> = {}, pantallas: LineaPantalla[][] = [AJUSTES]) {
  const { m, calls } = manos();
  let i = 0;
  const deps: IphoneToolDeps = {
    status: async () => READY,
    frame: async () => Buffer.from([0xff, 0xd8]),
    start: async () => undefined,
    stop: async () => undefined,
    home: async () => undefined,
    ocr: async () => ocrDe(pantallas[Math.min(i++, pantallas.length - 1)] ?? []),
    sleep: nada,
    gestos: true,
    manos: m,
    ...over,
  };
  const t = createIphoneTool(deps);
  const run = (args: Record<string, unknown>) =>
    t.execute('t', args as never) as unknown as Promise<{
      content: { type: string; text?: string }[];
      details: Record<string, unknown>;
    }>;
  return { run, calls, t };
}

describe('tool iphone: pasos sueltos (PA_IPHONE_GESTOS=1)', () => {
  it('apagados por defecto: lo dicen y no tocan nada', async () => {
    const { run, calls, t } = tool({ gestos: false });
    await expect(run({ action: 'tocar', x: 0.5, y: 0.5 })).rejects.toThrow(/PA_IPHONE_GESTOS=1/);
    expect(calls).toEqual([]);
    expect(t.description).not.toMatch(/tocar_texto/);
    expect(gestosActivados({})).toBe(false);
    expect(gestosActivados({ PA_IPHONE_GESTOS: '1' })).toBe(true);
  });

  it('tocar_texto toca el centro del texto y devuelve la pantalla de después', async () => {
    const despues = [L('Wi-Fi', 0.5, 0.1), L('Casa', 0.3, 0.3)];
    const { run, calls, t } = tool({}, [AJUSTES, despues]);
    expect(t.description).toMatch(/tocar_texto/);
    const r = await run({ action: 'tocar_texto', texto: 'Wi-Fi' });
    expect(calls).toEqual(['tap 0.25 0.26']);
    expect(r.content[0]?.text).toMatch(/Tocado «Wi-Fi»/);
    expect(r.content[0]?.text).toMatch(/Pantalla despues:[\s\S]*Casa/);
    expect(r.details).toEqual({ entrega: 'hecho', verified: false });
  });

  it('no toca la isla dinámica ni con el móvil bloqueado', async () => {
    const a = tool();
    await expect(a.run({ action: 'tocar', x: 0.5, y: 0.02 })).rejects.toThrow(/isla dinámica/);
    const b = tool({}, [BLOQUEO]);
    const r = await b.run({ action: 'tocar', x: 0.5, y: 0.5 });
    expect(r.details.bloqueado).toBe(true);
    const r2 = await b.run({ action: 'escribir', texto: '1234' });
    expect(r2.details.bloqueado).toBe(true);
    expect(a.calls).toEqual([]);
    expect(b.calls).toEqual([]);
  });

  it('no se pisa con el agente del servidor ni actúa con el puente a medias', async () => {
    const a = tool({
      status: async () => ({ ...READY, agent: { running: true, task: 'x', steps: 1 } }),
    });
    await expect(a.run({ action: 'atras' })).rejects.toThrow(/en marcha/);
    const b = tool({ status: async () => ({ ...READY, calibrated: false }) });
    await expect(b.run({ action: 'atras' })).rejects.toThrow(/no esta listo/);
    expect([...a.calls, ...b.calls]).toEqual([]);
  });

  it('un fallo al mandar deja la duda dicha: mirar antes de repetir', async () => {
    const { m } = manos();
    const { run } = tool({
      manos: {
        ...m,
        tap: async () => {
          throw new Error('El servidor del iPhone respondio 409: phone usb asleep');
        },
      },
    });
    const r = await run({ action: 'tocar', x: 0.4, y: 0.4 });
    expect(r.content[0]?.text).toMatch(/^Sin saber si se ha hecho/);
    expect(r.details.entrega).toBe('desconocido');
  });

  it('abrir_app y escribir con eñe: la receta entera, y la eñe rechazada sin mandar nada', async () => {
    const { run, calls } = tool();
    await run({ action: 'abrir_app', app: 'WhatsApp' });
    expect(calls).toEqual(['key cmd+h', 'key cmd+space', 'type WhatsApp', 'key enter']);
    await expect(run({ action: 'escribir', texto: 'mañana' })).rejects.toThrow(/«ñ»/);
    expect(calls).toHaveLength(4);
  });

  it('cada paso pide permiso a Nico en la Gate (opaco); texto y screenshot siguen siendo lecturas', () => {
    const gate = new Gate({ allowUntilPayment: true, approver: () => true });
    const at = (action: string) =>
      gate.classifyEffect({ tool: 'iphone', args: { action }, actor: 'test' });
    for (const a of [
      'tocar',
      'tocar_texto',
      'escribir',
      'tecla',
      'atras',
      'desplazar',
      'abrir_app',
    ])
      expect(at(a)).toBeNull();
    expect(at('texto')).toBe('lee');
  });
});

describe('IphoneClient: pasos sueltos del servidor', () => {
  it('manda x e y en fracciones a /api/tap y el combo a /api/key', async () => {
    const seen: { url: string; body?: string }[] = [];
    const f: FetchLike = async (url, init) => {
      seen.push({ url, body: init?.body });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
        text: async () => '',
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    };
    const c = new IphoneClient({ baseUrl: 'http://127.0.0.1:8890/', fetch: f });
    await c.tap(0.25, 0.5);
    await c.key('cmd+h');
    await c.back();
    expect(seen).toEqual([
      { url: 'http://127.0.0.1:8890/api/tap', body: '{"x":0.25,"y":0.5}' },
      { url: 'http://127.0.0.1:8890/api/key', body: '{"text":"cmd+h"}' },
      { url: 'http://127.0.0.1:8890/api/back', body: '{}' },
    ]);
  });
});
