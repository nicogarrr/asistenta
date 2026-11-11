import { describe, expect, it } from 'vitest';
import { bibliotecaElegir, bibliotecaOrden, bibliotecaVista } from '../src/biblioteca.js';
import { commandButton, commandFromCallback } from '../src/channels/telegram-shared.js';
import type { Creado } from '../src/creados.js';

// bugs-33 (11 nov 2026): el botón «📤 N» de /biblioteca llevaba solo la fecha al segundo
// del archivo. Dos archivos hechos en el mismo segundo con nombres distintos (la gráfica y
// su Excel, que una herramienta suelta a la vez) tenían la MISMA clave: «📤 2» mandaba el
// archivo 1.

const now = Date.parse('2026-11-11T12:00:00Z');
const lista: Creado[] = [
  { id: '20261111-115000-grafica.png', nombre: 'grafica.png', bytes: 40_000, creado: now - 60_000 },
  { id: '20261111-115000-datos.xlsx', nombre: 'datos.xlsx', bytes: 12_000, creado: now - 60_000 },
  {
    id: '20261110-200000-informe.pdf',
    nombre: 'informe.pdf',
    bytes: 9_000,
    creado: now - 86_400_000,
  },
];

describe('/biblioteca: cada botón manda SU archivo', () => {
  it('dos archivos del mismo segundo tienen botones distintos y cada uno trae el suyo', () => {
    const v = bibliotecaVista(lista, null, now);
    const claves = v.sends.map((s) => s.clave);
    expect(new Set(claves).size).toBe(claves.length);
    for (const [i, s] of v.sends.entries()) {
      const b = commandButton(s.label, 'biblioteca', s.clave, 'enviar');
      expect(b).toBeDefined();
      expect(Buffer.byteLength(b?.action ?? '')).toBeLessThanOrEqual(64);
      const cmd = commandFromCallback(b?.action ?? '') ?? '';
      const orden = bibliotecaOrden(cmd.replace(/^\/biblioteca\s+/, ''));
      expect(bibliotecaElegir(lista, orden)?.id).toBe(lista[i]?.id);
    }
  });

  it('un archivo solo en su segundo conserva la clave corta de siempre (botones ya enviados)', () => {
    const v = bibliotecaVista(lista, null, now);
    expect(v.sends[2]?.clave).toBe('20261110-200000');
    expect(bibliotecaElegir(lista, bibliotecaOrden('enviar 20261110-200000'))?.id).toBe(
      '20261110-200000-informe.pdf',
    );
  });
});
