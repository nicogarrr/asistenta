import { describe, expect, it } from 'vitest';
import { anuncioPendientes } from '../src/webui/client-format.js';
import { renderPage } from '../src/webui/page.js';

describe('panel: regiones vivas sin repetir', () => {
  const html = renderPage();

  it('las tarjetas que se repintan enteras no son regiones vivas', () => {
    for (const id of ['aprobaciones', 'objetivos', 'estado', 'sesiones', 'memoria', 'auditoria']) {
      const etiqueta = new RegExp(`<div id="panel-${id}"[^>]*>`).exec(html)?.[0] ?? '';
      expect(etiqueta, id).not.toBe('');
      expect(etiqueta, id).not.toContain('aria-live');
    }
  });

  it('la cuenta atrás (cambia cada segundo) no queda dentro de una región viva', () => {
    const vivas = [...html.matchAll(/<[a-z]+ [^>]*aria-live="(?:polite|assertive)"[^>]*>/g)].map(
      (m) => m[0],
    );
    const ids = vivas.map((v) => /id="([^"]+)"/.exec(v)?.[1]);
    expect(ids.sort()).toEqual(['actualizado', 'anuncio', 'panel-chat']);
  });

  it('hay un aviso solo para lector de pantalla, oculto a la vista', () => {
    expect(html).toMatch(
      /<p id="anuncio" class="solo-lector" role="status" aria-live="polite"><\/p>/,
    );
    expect(html).toMatch(/\.solo-lector \{[^}]*clip: rect\(0 0 0 0\)/);
    expect(html).toContain('formato.anuncioPendientes(pendientesPrevios, n)');
  });
});

describe('anuncioPendientes', () => {
  it('al abrir dice cuántas hay, si hay alguna', () => {
    expect(anuncioPendientes(null, 0)).toBe('');
    expect(anuncioPendientes(null, 1)).toBe('Tienes 1 aprobación pendiente.');
    expect(anuncioPendientes(null, 3)).toBe('Tienes 3 aprobaciones pendientes.');
  });

  it('solo anuncia las nuevas; nada si no cambia o baja', () => {
    expect(anuncioPendientes(2, 2)).toBe('');
    expect(anuncioPendientes(2, 1)).toBe('');
    expect(anuncioPendientes(1, 0)).toBe('');
    expect(anuncioPendientes(0, 1)).toBe('Nueva aprobación: 1 aprobación pendiente.');
    expect(anuncioPendientes(1, 4)).toBe('3 aprobaciones nuevas: 4 aprobaciones pendientes.');
  });

  it('tolera valores raros sin romper', () => {
    expect(anuncioPendientes(Number.NaN, 2)).toBe(
      '2 aprobaciones nuevas: 2 aprobaciones pendientes.',
    );
    expect(anuncioPendientes(0, -1)).toBe('');
  });
});
