import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  bibliotecaElegir,
  bibliotecaOrden,
  conVistaAnterior,
  vistaQueQueda,
} from '../src/biblioteca.js';
import type { Creado } from '../src/creados.js';

const now = Date.parse('2026-11-11T12:00:00+01:00');
const lista: Creado[] = [
  { id: '20261111-110000-grafica.png', nombre: 'grafica.png', bytes: 2048, creado: now - 1000 },
  { id: '20261111-100000-informe.pdf', nombre: 'informe.pdf', bytes: 2048, creado: now - 2000 },
];

describe('bugs-37: una búsqueda sin nada no cambia a qué lista cuenta «/biblioteca 2»', () => {
  it('sin filas no queda lista; con filas, sí', () => {
    expect(vistaQueQueda(null, 'contrato', 0, now)).toBeNull();
    expect(vistaQueQueda(null, 'informe', 1, now)).toEqual({
      filtro: null,
      busca: 'informe',
      at: now,
    });
    expect(vistaQueQueda('pdf', undefined, 2, now)).toEqual({ filtro: 'pdf', at: now });
  });

  it('tras «/biblioteca contrato» (nada), «/biblioteca 2» es el 2 de la lista entera', () => {
    const vista = vistaQueQueda(null, 'contrato', 0, now) ?? undefined;
    const o = conVistaAnterior(bibliotecaOrden('2'), vista, now);
    expect(bibliotecaElegir(lista, o)?.nombre).toBe('informe.pdf');
  });

  it('cli.ts guarda la lista solo con vistaQueQueda', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli).toContain('bib.vistaQueQueda(orden.filtro, orden.busca, v.sends.length');
    expect(cli).toContain('bibliotecaUltimaVista.delete(inbound.chatId)');
  });
});
