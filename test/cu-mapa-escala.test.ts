/**
 * Mapa del PC con la pantalla a una escala distinta de 100 % (125 %, 150 %).
 *
 * El mapa y el clic van en píxeles físicos (contexto DPI físico, #1908). Si aun
 * así UI Automation devuelve rectángulos en píxeles lógicos (lo que pasa cuando
 * el proceso que lee no recibe el contexto DPI), los números del mapa, las
 * marcas dibujadas y el clic por elemento caerían desplazados hacia arriba a la
 * izquierda. El script compara la ventana activa según Windows (GetWindowRect,
 * físico) y según UIA, y si no coinciden se corrige todo con ese factor.
 */
import { describe, expect, it } from 'vitest';
import {
  dpiFixOf,
  formatMap,
  mapDpiFix,
  mapScript,
  marksOf,
  parseElement,
  parseMap,
} from '../src/screen/ui-map.js';

// Ventana maximizada a 125 %: física 1920 de ancho en 0,0; UIA la ve de 1536.
const LOGICAL =
  'UIMAP {"w":"Sin título: Bloc de notas","p":"notepad","c":1,"d":[0,0,1920,0,0,1536],' +
  '"i":[{"s":"w","t":"Button","n":"Guardar","a":"","v":"","l":800,"o":400,"w":80,"h":24,"e":true,"f":false}]}';

describe('mapa con escala de pantalla ≠ 100 %', () => {
  it('el script mide la ventana en físico y según UIA', () => {
    const s = mapScript('m1');
    expect(s).toContain('GetWindowRect');
    expect(s).toContain('d = @($dpi)');
  });

  it('UIA en lógico (125 %): rectángulos, centro y marcas pasan a píxeles reales', () => {
    const map = parseMap(LOGICAL, 'm-125');
    const el = map.elements[0];
    expect(el).toMatchObject({ left: 1000, top: 500, width: 100, height: 30, x: 1050, y: 515 });
    expect(map.dpiScale).toBe(1.25);
    expect(marksOf(map)[0]).toMatchObject({ left: 1000, top: 500 });
    expect(formatMap(map)).toContain('corregido ×1,25');
  });

  it('el punto vivo del elemento (antes del clic) se corrige igual', () => {
    parseMap(LOGICAL, 'm-125b');
    const fix = mapDpiFix('m-125b');
    expect(parseElement('UIEL OK 840 412', fix)).toEqual({ state: 'ok', x: 1050, y: 515 });
  });

  it('ventana no maximizada en otro sitio: la corrección se ancla en la ventana', () => {
    // Física en 400,300 de 1200 de ancho; UIA (lógico 150 %) en 267,200 de 800.
    const fix = dpiFixOf([400, 300, 1200, 267, 200, 800]);
    expect(fix?.k).toBe(1.5);
    expect(parseElement('UIEL OK 367 250', fix ?? undefined)).toEqual({
      state: 'ok',
      x: 550,
      y: 375,
    });
  });

  it('a 100 % (o con UIA ya en físico) no toca nada', () => {
    expect(dpiFixOf([0, 0, 1920, 0, 0, 1920])).toBeNull();
    expect(dpiFixOf([-8, -8, 1936, -8, -8, 1930])).toBeNull(); // bordes, no escala
    expect(dpiFixOf(undefined)).toBeNull();
    expect(dpiFixOf([0, 0, 0, 0, 0, 0])).toBeNull();
    const map = parseMap(LOGICAL.replace('"d":[0,0,1920,0,0,1536],', ''), 'm-100');
    expect(map.elements[0]).toMatchObject({ left: 800, top: 400, x: 840, y: 412 });
    expect(map.dpiScale).toBeUndefined();
    expect(mapDpiFix('m-100')).toBeUndefined();
    expect(parseElement('UIEL OK 840 412', mapDpiFix('m-100'))).toEqual({
      state: 'ok',
      x: 840,
      y: 412,
    });
  });
});
