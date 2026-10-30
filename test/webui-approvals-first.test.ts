import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { tituloPestana } from '../src/webui/client-format.js';
import { renderFormatScript, renderPage } from '../src/webui/page.js';

describe('panel: las aprobaciones pendientes se ven sin buscarlas', () => {
  it('la tarjeta de aprobaciones va la primera, antes que el chat', () => {
    const html = renderPage();
    const aprobaciones = html.indexOf('aria-labelledby="titulo-aprobaciones"');
    const chat = html.indexOf('aria-labelledby="titulo-chat"');
    expect(aprobaciones).toBeGreaterThan(-1);
    expect(aprobaciones).toBeLessThan(chat);
  });

  it('su cuerpo no se recorta con scroll interno (los botones quedaban fuera de vista)', () => {
    expect(renderPage()).toMatch(/id="panel-aprobaciones" class="tarjeta-cuerpo sin-tope"/);
    expect(renderPage()).toContain('.tarjeta-cuerpo.sin-tope { max-height: none; }');
  });

  it('los objetivos tampoco se recortan y las tarjetas no se estiran vacías', () => {
    const html = renderPage();
    // Un objetivo bloqueado quedaba cortado a media frase dentro de un scroll interno.
    expect(html).toMatch(/id="panel-objetivos" class="tarjeta-cuerpo sin-tope"/);
    // Sin esto, «Estado» se estiraba hasta la altura de «Objetivos» con media tarjeta vacía.
    expect(html).toMatch(/\.rejilla \{[^}]*align-items: start;/);
  });

  it('cuenta las pendientes en la cabecera y en el título de la pestaña', () => {
    const html = renderPage();
    expect(html).toContain('id="contador-aprobaciones"');
    expect(html).toContain('document.title = formato.tituloPestana(n)');
    expect(tituloPestana(0)).toBe('Asistenta · Panel local');
    expect(tituloPestana(1)).toBe('(1) Asistenta · Panel local');
    expect(tituloPestana(3)).toBe('(3) Asistenta · Panel local');
    expect(tituloPestana(Number.NaN)).toBe('Asistenta · Panel local');
  });

  it('la copia del navegador da el mismo título', () => {
    const ctx: { asistentaFormato?: { tituloPestana: typeof tituloPestana } } = {};
    runInNewContext(
      renderFormatScript().replace('var asistentaFormato', 'this.asistentaFormato'),
      ctx,
    );
    expect(ctx.asistentaFormato?.tituloPestana(2)).toBe('(2) Asistenta · Panel local');
  });
});
