import { EventEmitter } from 'node:events';
import { existsSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  BleError,
  bleActivado,
  type CanalHid,
  faltanBle,
  ManosBle,
  ProcesoHid,
} from '../src/iphone/ble.js';
import {
  ABS_MAX,
  INFORME_ABSOLUTO,
  INFORME_RATON,
  INFORME_TECLADO,
  MAPA_INFORMES,
  type PasoHid,
  puntosDePantalla,
  secuenciaArrastre,
  secuenciaCombo,
  secuenciaTexto,
  secuenciaToque,
} from '../src/iphone/hid-informes.js';
import {
  capturarVentanaUxplay,
  leerSalidaCaptura,
  SinVentanaError,
  scriptCapturaVentana,
} from '../src/iphone/ventana.js';
import { guiaBle, iphoneToolDeps } from '../src/plugins/iphone.js';
import type { OcrResult } from '../src/screen/ocr.js';
import { createIphoneTool, type IphoneToolDeps } from '../src/tools/iphone.js';

/** Recorre el mapa como items cortos HID: bits de entrada por informe y colecciones cerradas. */
function analizarMapa(mapa: readonly number[]) {
  const bits = new Map<number, number>();
  let id = 0;
  let size = 0;
  let count = 0;
  let nivel = 0;
  let maxAbs = -1;
  let i = 0;
  while (i < mapa.length) {
    const pref = mapa[i] ?? 0;
    const n = [0, 1, 2, 4][pref & 3] ?? 0;
    const v = mapa.slice(i + 1, i + 1 + n).reduce((a, b, k) => a + (b << (8 * k)), 0);
    const tag = pref & 0xfc;
    if (tag === 0x84) id = v;
    else if (tag === 0x74) size = v;
    else if (tag === 0x94) count = v;
    else if (tag === 0xa0) nivel++;
    else if (tag === 0xc0) nivel--;
    else if (tag === 0x24 && id === INFORME_ABSOLUTO) maxAbs = v;
    else if (tag === 0x80) bits.set(id, (bits.get(id) ?? 0) + size * count);
    i += 1 + n;
  }
  return { bits, nivel, fin: i, maxAbs };
}

describe('mapa de informes HID (teclado + ratón + puntero absoluto)', () => {
  it('se recorre entero, cierra sus colecciones y cada informe mide lo que mandamos', () => {
    const a = analizarMapa(MAPA_INFORMES);
    expect(a.fin).toBe(MAPA_INFORMES.length);
    expect(a.nivel).toBe(0);
    expect(a.bits.get(INFORME_TECLADO)).toBe(8 * 8);
    expect(a.bits.get(INFORME_RATON)).toBe(4 * 8);
    expect(a.bits.get(INFORME_ABSOLUTO)).toBe(5 * 8);
    expect(a.maxAbs).toBe(ABS_MAX);
    expect(secuenciaToque(0.5, 0.5)[0]?.d).toHaveLength(5);
    expect(secuenciaTexto('a')[0]?.d).toHaveLength(8);
  });
});

const absXY = (p: PasoHid) => [
  (p.d[1] ?? 0) + ((p.d[2] ?? 0) << 8),
  (p.d[3] ?? 0) + ((p.d[4] ?? 0) << 8),
];

describe('gestos en informes (ideas de phoneuse)', () => {
  it('toque exacto: ir sin botón, esperar ~0,1 s, pulsar y soltar en el mismo sitio', () => {
    const s = secuenciaToque(0.25, 0.5);
    expect(s.map((p) => [p.r, p.d[0]])).toEqual([
      [INFORME_ABSOLUTO, 0],
      [INFORME_ABSOLUTO, 1],
      [INFORME_ABSOLUTO, 0],
    ]);
    expect(s[0]?.ms).toBeGreaterThanOrEqual(100);
    expect(absXY(s[1] as PasoHid)).toEqual([Math.round(0.25 * ABS_MAX), Math.round(0.5 * ABS_MAX)]);
    // Fuera de 0..1 se recorta, nunca se manda un número fuera de rango.
    expect(absXY(secuenciaToque(2, -1)[0] as PasoHid)).toEqual([ABS_MAX, 0]);
  });

  it('arrastre pausado: pulsa en absoluto, relativos de 8 ms sin botón, suelta en absoluto en el destino', () => {
    const pantalla = { ancho: 400, alto: 1000 };
    const s = secuenciaArrastre(0.5, 0.7, 0.5, 0.3, pantalla);
    expect(s[1]).toMatchObject({ r: INFORME_ABSOLUTO, d: [1, ...(s[1]?.d.slice(1) ?? [])] });
    const rel = s.filter((p) => p.r === INFORME_RATON);
    expect(rel.length).toBe(Math.floor(400 / 6.9));
    expect(rel.every((p) => p.ms === 8 && p.d[0] === 0 && p.d[1] === 0)).toBe(true);
    // hacia arriba: dy negativo en int8 (254 = -2)
    expect(rel.every((p) => p.d[2] === 254)).toBe(true);
    const ultimo = s.at(-1) as PasoHid;
    expect(ultimo.r).toBe(INFORME_ABSOLUTO);
    expect(ultimo.d[0]).toBe(0);
    expect(absXY(ultimo)[1]).toBe(Math.round(0.3 * ABS_MAX));
  });

  it('en diagonal no se tuerce: lo acumulado sigue la dirección', () => {
    const s = secuenciaArrastre(0.2, 0.2, 0.8, 0.5, { ancho: 400, alto: 800 });
    const toInt = (b: number) => (b > 127 ? b - 256 : b);
    const sx = s.filter((p) => p.r === INFORME_RATON).reduce((a, p) => a + toInt(p.d[1] ?? 0), 0);
    const sy = s.filter((p) => p.r === INFORME_RATON).reduce((a, p) => a + toInt(p.d[2] ?? 0), 0);
    expect(sx / sy).toBeCloseTo(240 / 240, 1);
  });

  it('teclado de EE. UU.: mayúsculas y signos con shift, combos con cmd, y la eñe no', () => {
    const t = secuenciaTexto('Hi!');
    expect(t.filter((_, i) => i % 2 === 0).map((p) => [p.d[0], p.d[2]])).toEqual([
      [0x02, 0x0b],
      [0x00, 0x0c],
      [0x02, 0x1e],
    ]);
    expect(t.filter((_, i) => i % 2 === 1).every((p) => p.d.every((b) => b === 0))).toBe(true);
    const c = secuenciaCombo('cmd+h');
    expect(c[1]?.d.slice(0, 3)).toEqual([0x08, 0, 0x0b]);
    expect(c.at(-1)?.d.every((b) => b === 0)).toBe(true);
    expect(() => secuenciaTexto('mañana')).toThrow(/«ñ»/);
    expect(puntosDePantalla('393x852')).toEqual({ ancho: 393, alto: 852 });
    expect(puntosDePantalla('nada')).toEqual({ ancho: 402, alto: 874 });
  });
});

class CanalFalso implements CanalHid {
  pedidos: Record<string, unknown>[] = [];
  respuesta: Record<string, unknown> = { ok: true };
  async pedir(msg: Record<string, unknown>) {
    this.pedidos.push(msg);
    return msg.op === 'estado'
      ? { ok: true, periferico: true, anunciando: true, conectado: true }
      : this.respuesta;
  }
}

describe('ManosBle: el ayudante recibe secuencias enteras', () => {
  it('tocar manda una sola petición con los informes en base64 y sus esperas', async () => {
    const canal = new CanalFalso();
    await new ManosBle(canal).tap(0.5, 0.5);
    const p = canal.pedidos[0] as { op: string; pasos: { r: number; d: string; ms: number }[] };
    expect(p.op).toBe('enviar');
    expect(p.pasos).toHaveLength(3);
    expect(Buffer.from(p.pasos[1]?.d ?? '', 'base64')[0]).toBe(1);
  });

  it('si el ayudante no lo manda todo, falla con cuántos salieron', async () => {
    const canal = new CanalFalso();
    canal.respuesta = { ok: false, enviados: 1, error: 'el iPhone no esta suscrito' };
    await expect(new ManosBle(canal).tap(0.5, 0.5)).rejects.toThrow(/1 de 3 informes/);
  });

  it('sin rol periférico lo dice claro y no pide nada más', () => {
    expect(faltanBle({ periferico: false, anunciando: false, conectado: false })[0]).toMatch(
      /periférico LE/,
    );
    expect(faltanBle({ periferico: true, anunciando: true, conectado: false })[0]).toMatch(
      /no está conectado/,
    );
    expect(faltanBle({ periferico: true, anunciando: true, conectado: true })).toEqual([]);
  });
});

/** Un proceso hijo de mentira: lo que se escribe en stdin y lo que contesta por stdout. */
function hijoFalso(contestar: (msg: Record<string, unknown>) => Record<string, unknown> | null) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const p = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill: () => true });
  const escrito: string[] = [];
  let resto = '';
  stdin.on('data', (b: Buffer) => {
    resto += b.toString();
    const lineas = resto.split('\n');
    resto = lineas.pop() ?? '';
    for (const l of lineas) {
      escrito.push(l);
      const r = contestar(JSON.parse(l) as Record<string, unknown>);
      if (r) stdout.write(`${JSON.stringify(r)}\n`);
    }
  });
  return { p, escrito };
}

describe('ProcesoHid: hablar con el ayudante', () => {
  it('lo primero que recibe es el mapa; luego cada respuesta vuelve por su id', async () => {
    const h = hijoFalso((m) =>
      m.op === 'estado' ? { id: m.id, ok: true, periferico: true } : null,
    );
    const proc = new ProcesoHid(() => h.p as never, 'win32');
    const r = await proc.pedir({ op: 'estado' });
    expect(r.periferico).toBe(true);
    const primero = JSON.parse(h.escrito[0] ?? '{}') as { op: string; d: string };
    expect(primero.op).toBe('mapa');
    expect([...Buffer.from(primero.d, 'base64')]).toEqual([...MAPA_INFORMES]);
  });

  it('si el ayudante se cierra, lo pendiente falla con el motivo (y no se queda colgado)', async () => {
    const h = hijoFalso(() => null);
    const proc = new ProcesoHid(() => h.p as never, 'win32');
    const pendiente = proc.pedir({ op: 'enviar', pasos: [] });
    h.p.stderr.write('Bluetooth apagado\n');
    await new Promise((r) => setTimeout(r, 10));
    h.p.emit('exit', 3);
    await expect(pendiente).rejects.toThrow(/se ha cerrado[\s\S]*Bluetooth apagado/);
  });

  it('fuera de Windows ni lo intenta', () => {
    const proc = new ProcesoHid(() => {
      throw new Error('no debería lanzarse');
    }, 'linux');
    expect(() => proc.pedir({ op: 'estado' })).toThrow(BleError);
  });
});

describe('pantalla desde la ventana de UxPlay', () => {
  it('el script busca uxplay.exe, usa PrintWindow y escapa la ruta', () => {
    const s = scriptCapturaVentana("C:\\Temp\\o'k.jpg");
    expect(s).toMatch(/Get-Process -Name 'uxplay'/);
    expect(s).toMatch(/PrintWindow/);
    expect(s).toContain("'C:\\Temp\\o''k.jpg'");
  });

  it('lee el recorte y explica cuando no hay ventana o está minimizada', () => {
    const r = leerSalidaCaptura(
      'x\r\nUXPLAY_CAPTURA {"vx":10,"vy":20,"vw":500,"vh":900,"x":5,"y":0,"w":490,"h":900}\r\n',
    );
    expect(r).toEqual({
      ventana: { x: 10, y: 20, ancho: 500, alto: 900 },
      recorte: { x: 5, y: 0, ancho: 490, alto: 900 },
    });
    expect(() => leerSalidaCaptura('UXPLAY_SIN_VENTANA')).toThrow(SinVentanaError);
    expect(() => leerSalidaCaptura('UXPLAY_MINIMIZADA')).toThrow(/minimizada/);
  });

  it('devuelve el JPEG y borra siempre el temporal', async () => {
    let ruta = '';
    const r = await capturarVentanaUxplay(async (script) => {
      ruta = /Save\('([^']+)'/.exec(script)?.[1] ?? '';
      writeFileSync(ruta, Buffer.from([0xff, 0xd8, 0xff]));
      return 'UXPLAY_CAPTURA {"vx":0,"vy":0,"vw":100,"vh":200,"x":0,"y":0,"w":100,"h":200}';
    }, 'win32');
    expect([...r.jpeg]).toEqual([0xff, 0xd8, 0xff]);
    expect(existsSync(ruta)).toBe(false);
    await expect(capturarVentanaUxplay(async () => '', 'linux')).rejects.toThrow(/Windows/);
  });
});

function ocrDe(lineas: { texto: string; x: number; y: number }[]): OcrResult {
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

describe('tool iphone en modo Bluetooth (PA_IPHONE_BLE=1): mismas guardas que con la ESP32', () => {
  function tool(
    canal: CanalFalso,
    pantalla = [
      { texto: 'Ajustes', x: 0.5, y: 0.1 },
      { texto: 'Wi-Fi', x: 0.3, y: 0.3 },
    ],
  ) {
    const manos = new ManosBle(canal);
    const deps: IphoneToolDeps = {
      modo: 'ble',
      status: async () => ({
        device: true,
        screen: true,
        calibrated: true,
        models: { planner: '', actor: '' },
        agent: { running: false, task: null, steps: 0 },
      }),
      frame: async () => Buffer.from([0xff, 0xd8]),
      start: async () => {
        throw new Error('En modo Bluetooth no hay agente del teléfono');
      },
      stop: () => manos.soltar(),
      home: () => manos.key('cmd+h'),
      ocr: async () => ocrDe(pantalla),
      gestos: true,
      manos,
      sleep: async () => undefined,
    };
    const t = createIphoneTool(deps);
    return {
      t,
      run: (args: Record<string, unknown>) =>
        t.execute('t', args as never) as unknown as Promise<{
          content: { text?: string }[];
          details: Record<string, unknown>;
        }>,
    };
  }

  it('tocar_texto llega como toque absoluto al ayudante', async () => {
    const canal = new CanalFalso();
    const { run, t } = tool(canal);
    expect(t.description).toMatch(/Bluetooth/);
    const r = await run({ action: 'tocar_texto', texto: 'Wi-Fi' });
    expect(r.details.entrega).toBe('hecho');
    const env = canal.pedidos.filter((p) => p.op === 'enviar');
    expect(env).toHaveLength(1);
  });

  it('un fallo de radio al mandar: «Sin saber si se ha hecho»', async () => {
    const canal = new CanalFalso();
    canal.respuesta = { ok: false, enviados: 2, error: 'desconectado' };
    const { run } = tool(canal);
    const r = await run({ action: 'tocar', x: 0.4, y: 0.4 });
    expect(r.content[0]?.text).toMatch(/^Sin saber si se ha hecho/);
    expect(r.details.entrega).toBe('desconocido');
  });

  it('con el móvil bloqueado no manda nada, ni toca la isla dinámica', async () => {
    const canal = new CanalFalso();
    const { run } = tool(canal, [
      { texto: 'Introduce el código', x: 0.5, y: 0.3 },
      { texto: 'Emergencia', x: 0.2, y: 0.9 },
      { texto: 'Cancelar', x: 0.8, y: 0.9 },
    ]);
    const r = await run({ action: 'escribir', texto: '1234' });
    expect(r.details.bloqueado).toBe(true);
    await expect(run({ action: 'tocar', x: 0.5, y: 0.02 })).rejects.toThrow(/isla dinámica/);
    expect(canal.pedidos.filter((p) => p.op === 'enviar')).toEqual([]);
  });

  it('la parada suelta todo y status dice «Bluetooth»', async () => {
    const canal = new CanalFalso();
    const { run } = tool(canal);
    await run({ action: 'stop' });
    expect(canal.pedidos.at(-1)?.op).toBe('enviar');
    const s = await run({ action: 'status' });
    expect(s.content[0]?.text).toMatch(/Bluetooth/);
  });
});

describe('cableado del modo Bluetooth', () => {
  it('apagado por defecto; con PA_IPHONE_BLE=1 la tool va por Bluetooth', () => {
    expect(bleActivado({})).toBe(false);
    expect(bleActivado({ PA_IPHONE_BLE: '1' })).toBe(true);
    expect(iphoneToolDeps({ PA_IPHONE_BLE: '1' }).modo).toBe('ble');
    expect(iphoneToolDeps({}).modo).toBeUndefined();
  });

  it('el alta guiada pone primero lo que falta del Bluetooth', () => {
    const g = guiaBle({ periferico: false, anunciando: false, conectado: false }, false);
    expect(g.next).toMatch(/periférico LE/);
    const ok = guiaBle({ periferico: true, anunciando: true, conectado: true }, true);
    expect(ok.next).toBeNull();
    expect(guiaBle(null, false, 'ENOENT').next).toMatch(/compilar-hid\.ps1/);
  });
});
