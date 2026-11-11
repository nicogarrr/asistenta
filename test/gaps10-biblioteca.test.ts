import { describe, expect, it } from 'vitest';
import {
  BIBLIOTECA_MAX,
  bibliotecaElegir,
  bibliotecaOrden,
  bibliotecaVista,
  claveDe,
  filtroDe,
} from '../src/biblioteca.js';
import { commandButton, commandFromCallback } from '../src/channels/telegram-shared.js';
import type { Creado } from '../src/creados.js';

const now = Date.parse('2026-11-11T12:00:00+01:00');
const c = (id: string, bytes: number, ago: number): Creado => ({
  id,
  nombre: id.replace(/^\d{8}-\d{6}(?:-\d+)?-/, ''),
  bytes,
  creado: now - ago,
});
const lista = [
  c('20261111-115000-grafica.png', 40_000, 10 * 60_000),
  c('20261110-200000-Gastos-de-octubre.xlsx', 12_000, 16 * 3600_000),
  c('20261105-090000-Informe-ASTS.pdf', 2_500_000, 6 * 86_400_000),
  c('20261105-090000-2-Informe-ASTS.pdf', 2_400_000, 6 * 86_400_000 + 1),
];

describe('/biblioteca (Grok Bot: Library de lo que el bot creó, por tipo)', () => {
  it('lista lo último con tipo, tamaño y cuándo, y un 📤 por archivo', () => {
    const v = bibliotecaVista(lista, null, now);
    expect(v.text).toContain('📚 Lo que te he hecho: 4');
    expect(v.text).toContain('1. 🖼️ grafica.png · 39 KB · hoy');
    expect(v.text).toContain('2. 📊 Gastos-de-octubre.xlsx · 12 KB · ayer');
    expect(v.text).toContain('3. 📄 Informe-ASTS.pdf · 2,4 MB');
    expect(v.sends.map((s) => s.clave)).toEqual([
      '20261111-115000',
      '20261110-200000',
      '20261105-090000',
      '20261105-090000-2',
    ]);
  });

  it('el botón cabe en callback_data y vuelve como /biblioteca enviar <clave>', () => {
    const b = commandButton('📤 1', 'biblioteca', '20261105-090000-2', 'enviar');
    expect(b).toBeDefined();
    expect(Buffer.byteLength(b?.action ?? '')).toBeLessThanOrEqual(64);
    expect(commandFromCallback(b?.action ?? '')).toBe('/biblioteca enviar 20261105-090000-2');
    const o = bibliotecaOrden('enviar 20261105-090000-2');
    expect(bibliotecaElegir(lista, o)?.id).toBe('20261105-090000-2-Informe-ASTS.pdf');
    expect(bibliotecaElegir(lista, bibliotecaOrden('enviar 20261105-090000'))?.id).toBe(
      '20261105-090000-Informe-ASTS.pdf',
    );
  });

  it('filtra por tipo con palabras de a pie', () => {
    expect(filtroDe('excels')).toBe('excel');
    expect(filtroDe('las gráficas')).toBe('imagen');
    expect(filtroDe('PDF')).toBe('pdf');
    expect(filtroDe('pepino')).toBeNull();
    const v = bibliotecaVista(lista, 'pdf', now);
    expect(v.text).toContain('(pdf): 2');
    expect(v.text).not.toContain('grafica');
    expect(bibliotecaVista(lista, 'word', now).text).toContain('No tengo ningún Word');
  });

  it('/biblioteca N y /biblioteca pdf N eligen de la lista que se ve', () => {
    expect(bibliotecaElegir(lista, bibliotecaOrden('2'))?.nombre).toBe('Gastos-de-octubre.xlsx');
    expect(bibliotecaElegir(lista, bibliotecaOrden('pdf 2'))?.id).toBe(
      '20261105-090000-2-Informe-ASTS.pdf',
    );
    expect(bibliotecaElegir(lista, bibliotecaOrden('9'))).toBeNull();
    expect(bibliotecaOrden('pepino 2').kind).toBe('ayuda');
    expect(bibliotecaOrden('cosas raras').kind).toBe('ayuda');
  });

  it('vacía, lo dice; más de 10, enseña 10 y cuenta el resto', () => {
    expect(bibliotecaVista([], null, now).text).toContain('Aún no te he hecho ningún archivo');
    const many = Array.from({ length: 13 }, (_, i) =>
      c(`20261111-1100${String(i).padStart(2, '0')}-g${i}.png`, 1000, i * 1000),
    );
    const v = bibliotecaVista(many, null, now);
    expect(v.sends).toHaveLength(BIBLIOTECA_MAX);
    expect(v.text).toContain('…y 3 más.');
  });

  it('la clave es solo la fecha del id', () => {
    expect(claveDe('20261111-115000-grafica.png')).toBe('20261111-115000');
    expect(claveDe('basura')).toBe('');
  });
});
