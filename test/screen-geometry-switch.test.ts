import { describe, expect, it, vi } from 'vitest';
import { computerSwitchCommand } from '../src/screen/computer-switch.js';
import {
  jpegGeometry,
  parseCaptureGeometry,
  physicalScript,
} from '../src/screen/windows-geometry.js';

// Solo pruebas de caracterización: congelan lo que Computer Use hace hoy en Windows.

const cap = (g: Record<string, unknown>) => `PA_CAPTURE ${JSON.stringify(g)}`;

describe('parseCaptureGeometry', () => {
  it('acepta la línea PA_CAPTURE entre otras salidas y con CRLF', () => {
    const out = `aviso\r\n${cap({ width: 1366, height: 768, nativeWidth: 2560, nativeHeight: 1440 })}\r\nfin\r\n`;
    expect(parseCaptureGeometry(out)).toEqual({
      width: 1366,
      height: 768,
      nativeWidth: 2560,
      nativeHeight: 1440,
    });
  });

  it('sin línea o con dos líneas PA_CAPTURE: error que pide otra captura', () => {
    expect(() => parseCaptureGeometry('nada')).toThrow(/ausente o ambigua/);
    const g = cap({ width: 10, height: 10, nativeWidth: 10, nativeHeight: 10 });
    expect(() => parseCaptureGeometry(`${g}\n${g}`)).toThrow(/ausente o ambigua/);
  });

  it('una línea PA_CAPTURE con el JSON roto pide otra captura, no suelta un SyntaxError', () => {
    expect(() => parseCaptureGeometry('PA_CAPTURE {"width":1366,')).toThrow(/ilegible/);
  });

  it.each([
    ['cero', { width: 0, height: 10, nativeWidth: 10, nativeHeight: 10 }],
    ['negativo', { width: -5, height: 10, nativeWidth: 10, nativeHeight: 10 }],
    ['decimal', { width: 10.5, height: 10, nativeWidth: 20, nativeHeight: 20 }],
    ['texto', { width: '10', height: 10, nativeWidth: 10, nativeHeight: 10 }],
    ['falta un campo', { width: 10, height: 10, nativeWidth: 10 }],
    ['más de 32768', { width: 40000, height: 10, nativeWidth: 40000, nativeHeight: 10 }],
    ['captura mayor que la pantalla', { width: 20, height: 10, nativeWidth: 10, nativeHeight: 10 }],
  ])('rechaza geometría inválida: %s', (_n, g) => {
    expect(() => parseCaptureGeometry(cap(g))).toThrow(/inválida/);
  });

  it('un píxel de diferencia por redondeo se acepta; otra proporción no', () => {
    expect(() =>
      parseCaptureGeometry(
        cap({ width: 1366, height: 769, nativeWidth: 2560, nativeHeight: 1440 }),
      ),
    ).not.toThrow();
    expect(() =>
      parseCaptureGeometry(
        cap({ width: 1280, height: 1024, nativeWidth: 2560, nativeHeight: 1440 }),
      ),
    ).toThrow(/incoherente/);
  });

  it('JSON roto en la línea PA_CAPTURE: lanza (no devuelve una geometría a medias)', () => {
    expect(() => parseCaptureGeometry('PA_CAPTURE {width:')).toThrow();
  });
});

function jpeg(...segments: number[][]): Buffer {
  return Buffer.from([0xff, 0xd8, ...segments.flat(), 0xff, 0xd9]);
}
const seg = (marker: number, payload: number[]) => [
  0xff,
  marker,
  (payload.length + 2) >> 8,
  (payload.length + 2) & 0xff,
  ...payload,
];
// SOF: precisión, alto (2), ancho (2), componentes.
const sof = (marker: number, w: number, h: number) =>
  seg(marker, [8, h >> 8, h & 0xff, w >> 8, w & 0xff, 1, 1, 0x11, 0]);

describe('jpegGeometry', () => {
  it('lee ancho y alto del SOF0 tras APP0 y DQT', () => {
    const b = jpeg(
      seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0]),
      seg(0xdb, new Array(65).fill(1)),
      sof(0xc0, 1366, 768),
    );
    expect(jpegGeometry(b)).toEqual({ width: 1366, height: 768 });
  });

  it('JPEG progresivo (SOF2) y bytes de relleno 0xFF antes del marcador', () => {
    const b = jpeg([0xff, 0xff], sof(0xc2, 640, 480));
    expect(jpegGeometry(b)).toEqual({ width: 640, height: 480 });
  });

  it('DHT (0xC4) no se confunde con un SOF', () => {
    const dht = seg(0xc4, [0, 1, 2, 3, 4, 5, 6, 7]);
    expect(jpegGeometry(jpeg(dht, sof(0xc0, 100, 50)))).toEqual({ width: 100, height: 50 });
  });

  it('no es JPEG: error claro', () => {
    expect(() => jpegGeometry(Buffer.from('\x89PNG\r\n'))).toThrow(/no es JPEG/);
  });

  it('sin SOF antes del inicio de imagen (SOS), truncado o con tamaño 0: no inventa dimensiones', () => {
    expect(() => jpegGeometry(jpeg(seg(0xda, [0, 0, 0]), sof(0xc0, 10, 10)))).toThrow(
      /sin dimensiones/,
    );
    expect(() => jpegGeometry(jpeg(sof(0xc0, 0, 10)))).toThrow(/sin dimensiones/);
    const full = jpeg(sof(0xc0, 10, 10));
    expect(() => jpegGeometry(full.subarray(0, 8))).toThrow(/sin dimensiones/);
    expect(() => jpegGeometry(Buffer.from([0xff, 0xd8]))).toThrow(/sin dimensiones/);
  });
});

describe('physicalScript', () => {
  it('envuelve el script en try/finally que restaura el contexto DPI y para ante cualquier error', () => {
    const s = physicalScript('Write-Output hola');
    expect(s.startsWith("$ErrorActionPreference='Stop'")).toBe(true);
    const at = s.indexOf('Write-Output hola');
    expect(s.lastIndexOf('try {', at)).toBeGreaterThan(
      s.indexOf('SetThreadDpiAwarenessContext($physicalContext)'),
    );
    expect(s.indexOf('} finally {', at)).toBeGreaterThan(at);
    expect(s.slice(at)).toContain('SetThreadDpiAwarenessContext($previousContext)');
    expect(s).toContain('No se pudo verificar DPI físico');
  });
});

describe('/ordenador: todas las palabras y nadie más que el dueño', () => {
  const deps = (on: boolean, isOwner = true) => {
    const set = vi.fn();
    return { set, d: { isOwner, enabled: () => on, set } };
  };

  it.each(['off', 'OFF', ' apagar ', 'apaga', 'desactivar', 'desactiva', 'no', '0', 'stop'])(
    '«%s» apaga',
    (w) => {
      const { set, d } = deps(true);
      expect(computerSwitchCommand(w, d)).toMatch(/desactivado/);
      expect(set).toHaveBeenCalledWith(false);
    },
  );

  it.each(['on', 'On', 'encender', 'enciende', 'activar', 'activa', 'si', 'sí', '1'])(
    '«%s» enciende',
    (w) => {
      const { set, d } = deps(false);
      expect(computerSwitchCommand(w, d)).toMatch(/activado/);
      expect(set).toHaveBeenCalledWith(true);
    },
  );

  it('vacío o «estado» solo informa', () => {
    const a = deps(true);
    expect(computerSwitchCommand('', a.d)).toMatch(/ACTIVADO/);
    const b = deps(false);
    expect(computerSwitchCommand('estado', b.d)).toMatch(/DESACTIVADO/);
    expect(a.set).not.toHaveBeenCalled();
    expect(b.set).not.toHaveBeenCalled();
  });

  it('palabra desconocida: uso, sin cambiar nada', () => {
    const { set, d } = deps(true);
    expect(computerSwitchCommand('quizás', d)).toMatch(/^¿Enciendo o apago el control de tu PC\?/);
    expect(set).not.toHaveBeenCalled();
  });

  it('quien no es el dueño no cambia nada, diga lo que diga', () => {
    for (const w of ['off', 'on', '', 'estado']) {
      const { set, d } = deps(true, false);
      expect(computerSwitchCommand(w, d)).toMatch(/Solo el dueño/);
      expect(set).not.toHaveBeenCalled();
    }
  });
});
