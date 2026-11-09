import { describe, expect, it } from 'vitest';
import { esperarQuieta, firmaLineas } from '../src/iphone/quieta.js';
import type { LineaPantalla } from '../src/iphone/texto.js';
import type { OcrResult } from '../src/screen/ocr.js';
import { createIphoneTool, type IphoneToolDeps } from '../src/tools/iphone.js';

const L = (texto: string, x: number, y: number): LineaPantalla => ({ texto, x, y });

/** Lecturas en orden; la última se repite. */
function secuencia(firmas: string[]) {
  let i = 0;
  return async () => firmas[Math.min(i++, firmas.length - 1)] ?? '';
}
const nada = async () => undefined;
const reloj = () => 0;

describe('esperarQuieta: settle en vez de pausa fija (idea de phoneuse)', () => {
  it('espera a que cambie y luego a dos lecturas iguales', async () => {
    const r = await esperarQuieta({
      leer: secuencia(['A', 'B', 'C', 'C']),
      firma: (s) => s,
      antes: 'A',
      espera: nada,
      ahora: reloj,
    });
    expect(r).toMatchObject({ lectura: 'C', cambio: true, quieta: true });
  });

  it('si nada cambia, lo dice tras sinCambioMs y no espera hasta el tope', async () => {
    const esperas: number[] = [];
    const r = await esperarQuieta({
      leer: secuencia(['A']),
      firma: (s) => s,
      antes: 'A',
      espera: async (ms) => {
        esperas.push(ms);
      },
      ahora: reloj,
      minimoMs: 100,
      intervaloMs: 200,
      sinCambioMs: 1000,
      maximoMs: 3000,
    });
    expect(r).toMatchObject({ cambio: false, quieta: true });
    expect(esperas.reduce((a, b) => a + b, 0)).toBeLessThan(1500);
  });

  it('si no para de moverse, devuelve lo último al tope y lo marca', async () => {
    let n = 0;
    const r = await esperarQuieta({
      leer: async () => String(n++),
      firma: (s) => s,
      antes: 'x',
      espera: nada,
      ahora: reloj,
      maximoMs: 1000,
    });
    expect(r.quieta).toBe(false);
    expect(r.cambio).toBe(true);
  });

  it('sin «antes»: dos lecturas iguales bastan y el cambio queda sin saber', async () => {
    const r = await esperarQuieta({
      leer: secuencia(['B', 'B']),
      firma: (s) => s,
      espera: nada,
      ahora: reloj,
    });
    expect(r).toMatchObject({ lectura: 'B', cambio: null, quieta: true });
  });

  it('la firma no cuenta el baile de un píxel del OCR ni el orden', () => {
    const a = firmaLineas([L('Wi-Fi', 0.24, 0.26), L('Bluetooth', 0.24, 0.32)]);
    const b = firmaLineas([L('Bluetooth', 0.242, 0.322), L('Wi-Fi', 0.239, 0.259)]);
    expect(a).toBe(b);
    expect(firmaLineas([L('Wi-Fi', 0.25, 0.5)])).not.toBe(a);
  });
});

function ocrDe(lineas: LineaPantalla[]): OcrResult {
  return {
    width: 1000,
    height: 1000,
    language: 'es-ES',
    text: '',
    lines: lineas.map((l) => ({
      text: l.texto,
      x: l.x * 1000 - 10,
      y: l.y * 1000 - 5,
      width: 20,
      height: 10,
      words: [],
    })),
  };
}

const READY = {
  device: true,
  screen: true,
  calibrated: true,
  models: { planner: 'p', actor: 'a' },
  agent: { running: false, task: null, steps: 0 },
};

function tool(pantallas: LineaPantalla[][]) {
  let i = 0;
  const calls: string[] = [];
  const deps: IphoneToolDeps = {
    status: async () => READY,
    frame: async () => Buffer.from([0xff, 0xd8]),
    start: nada,
    stop: nada,
    home: nada,
    ocr: async () => ocrDe(pantallas[Math.min(i++, pantallas.length - 1)] ?? []),
    sleep: nada,
    gestos: true,
    manos: {
      tap: async (x, y) => {
        calls.push(`tap ${x} ${y}`);
      },
      swipe: nada,
      type: nada,
      key: nada,
      back: nada,
    },
  };
  const t = createIphoneTool(deps);
  return (args: Record<string, unknown>) =>
    t.execute('t', args as never) as unknown as Promise<{
      content: { type: string; text?: string }[];
      details: Record<string, unknown>;
    }>;
}

describe('tool iphone: la pantalla de después es la que se queda quieta', () => {
  const AJUSTES = [L('Ajustes', 0.5, 0.1), L('Wi-Fi', 0.25, 0.26)];
  it('un paso que carga en dos tiempos devuelve la pantalla final, no la de en medio', async () => {
    const cargando = [L('Wi-Fi', 0.5, 0.1), L('Buscando', 0.5, 0.3)];
    const final = [L('Wi-Fi', 0.5, 0.1), L('Casa', 0.3, 0.3)];
    const run = tool([AJUSTES, cargando, final]);
    const r = await run({ action: 'tocar_texto', texto: 'Wi-Fi' });
    expect(r.content[0]?.text).toMatch(/Pantalla despues:[\s\S]*Casa/);
    expect(r.content[0]?.text).not.toMatch(/Buscando/);
    expect(r.details).toMatchObject({ entrega: 'hecho', pantalla: { cambio: true, quieta: true } });
  });

  it('si el toque no movió nada, lo dice para no repetir a ciegas', async () => {
    const run = tool([AJUSTES]);
    const r = await run({ action: 'tocar_texto', texto: 'Wi-Fi' });
    expect(r.content[0]?.text).toMatch(/NO ha cambiado/);
    expect(r.details).toMatchObject({ pantalla: { cambio: false } });
  });
});
