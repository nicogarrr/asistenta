import { describe, expect, it } from 'vitest';
import { formatMap, mapScript, parseMap, TASKBAR_LIMIT } from '../src/screen/ui-map.js';

/**
 * Mapa completo de lo que se puede pulsar: menús o emergentes abiertos (ventanas propias,
 * no hijas de la activa), la ventana activa y la barra de tareas para cambiar de app.
 */

const row = (s: string, t: string, n: string, l: number) =>
  `{"s":"${s}","t":"${t}","n":"${n}","a":"","v":"","l":${l},"o":10,"w":40,"h":20,"e":true,"f":false}`;

const DUMP =
  'UIMAP {"w":"Sin t\\u00edtulo: Bloc de notas","p":"Notepad","c":5,"x":false,"i":[' +
  [
    row('m', 'MenuItem', 'Nuevo', 10),
    row('m', 'MenuItem', 'Guardar como', 60),
    row('v', 'Document', 'Editor de texto', 110),
    row('b', 'Button', 'Inicio', 160),
    row('b', 'Button', 'Spotify - 1 ventana en ejecuci\\u00f3n', 210),
  ].join(',') +
  ']}';

describe('mapa completo: menús, ventana y barra de tareas', () => {
  it('lee la sección de cada elemento (sin sección = ventana, como antes)', () => {
    const map = parseMap(DUMP, 'm');
    expect(map.elements.map((e) => e.section)).toEqual([
      'menu',
      'menu',
      'ventana',
      'barra',
      'barra',
    ]);
    const old = parseMap(
      'UIMAP {"w":"X","i":[{"t":"Button","n":"OK","l":1,"o":1,"w":2,"h":2}]}',
      'm',
    );
    expect(old.elements[0]?.section).toBe('ventana');
  });

  it('con varias secciones el texto las separa con un título', () => {
    const out = formatMap(parseMap(DUMP, 'm'));
    expect(out).toContain('Menú o ventana emergente abierta:\n[1] Menú «Nuevo»');
    expect(out).toContain('Ventana activa:\n[3] Documento «Editor de texto»');
    expect(out).toContain('Barra de tareas (para cambiar de app):\n[4] Botón «Inicio»');
    expect(out).toContain('[5] Botón «Spotify - 1 ventana en ejecución»');
  });

  it('solo la ventana: sin títulos, igual que antes', () => {
    const only = `UIMAP {"w":"X","c":1,"i":[${row('v', 'Button', 'OK', 1)}]}`;
    const out = formatMap(parseMap(only, 'm'));
    expect(out).not.toContain('Ventana activa:');
    expect(out).toContain('[1] Botón «OK»');
  });

  it('ventana opaca (Chromium) con barra de tareas: lo dice y deja la barra', () => {
    const opaque = `UIMAP {"w":"Chrome","c":1,"i":[${row('b', 'Button', 'Inicio', 1)}]}`;
    const out = formatMap(parseMap(opaque, 'm'));
    expect(out).toContain('[1] Botón «Inicio»');
    expect(out).toContain('(La ventana activa no expone ningún control accionable');
  });

  it('el script busca menús abiertos, la ventana del foco y la barra de tareas, sin repetir', () => {
    const s = mapScript('m1');
    expect(s).toContain('[System.Windows.Automation.ControlType]::Menu');
    expect(s).toContain('$A::FocusedElement');
    expect(s).toContain("'Shell_TrayWnd'");
    expect(s).toContain('Test-PaSeen');
    expect(s).toContain(`$barRows -lt ${TASKBAR_LIMIT}`);
    // Menús primero, luego la ventana, la barra al final (no se come el límite de la ventana).
    expect(s.indexOf('ControlType]::Menu')).toBeLessThan(s.indexOf("@($win, 'v')"));
    expect(s.indexOf("@($win, 'v')")).toBeLessThan(s.indexOf('Shell_TrayWnd'));
  });
});
