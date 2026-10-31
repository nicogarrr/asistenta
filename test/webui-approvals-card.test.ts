import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { resumenAprobacion, tiempoRestante } from '../src/webui/client-format.js';
import { renderFormatScript, renderPage } from '../src/webui/page.js';

const pendiente = {
  id: 'apr_01',
  tool: 'browser_click',
  reason: 'Pago en una web nueva (vueling.com)',
  question: '¿Pulso «Pagar 142,30 €» en vueling.com?',
  createdAt: 1_000,
  expiresAt: 301_000,
  chatId: '12345',
};

function scripts(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
}

describe('panel: tarjeta de aprobación legible', () => {
  it('titula con la pregunta humana, no con el nombre interno de la herramienta', () => {
    const r = resumenAprobacion(pendiente, 0);
    expect(r.titulo).toBe('¿Pulso «Pagar 142,30 €» en vueling.com?');
    expect(r.motivo).toBe('Pago en una web nueva (vueling.com)');
    expect(r.herramienta).toBe('browser_click');
    expect(r.caduca).toBe(301_000);
  });

  it('cae al motivo, luego a la herramienta y por último a un número', () => {
    expect(resumenAprobacion({ tool: 'mail_send', reason: 'Correo externo' }, 0).titulo).toBe(
      'Correo externo',
    );
    expect(resumenAprobacion({ tool: 'mail_send', reason: 'Correo externo' }, 0).motivo).toBe('');
    expect(resumenAprobacion({ tool: 'mail_send' }, 0).titulo).toBe('mail_send');
    expect(resumenAprobacion({}, 2).titulo).toBe('Aprobación 3');
    expect(resumenAprobacion('texto suelto', 0).titulo).toBe('texto suelto');
    expect(resumenAprobacion({ expiresAt: '2026-10-30T12:00:00Z' }, 0).caduca).toBe(
      Date.parse('2026-10-30T12:00:00Z'),
    );
  });

  it('muestra la cuenta atrás en español en vez de un epoch en milisegundos', () => {
    expect(tiempoRestante(301_000, 41_000)).toBe('Caduca en 4 min 20 s');
    expect(tiempoRestante(301_000, 61_000)).toBe('Caduca en 4 min');
    expect(tiempoRestante(301_000, 289_000)).toBe('Caduca en 12 s');
    expect(tiempoRestante(301_000, 301_000)).toBe('Caducada');
    expect(tiempoRestante(null, 0)).toBe('');
  });

  it('la copia que llega al navegador se comporta igual que el módulo', () => {
    const ctx: {
      asistentaFormato?: {
        resumenAprobacion: typeof resumenAprobacion;
        tiempoRestante: typeof tiempoRestante;
      };
    } = {};
    runInNewContext(
      renderFormatScript().replace('var asistentaFormato', 'this.asistentaFormato'),
      ctx,
    );
    const f = ctx.asistentaFormato;
    expect(f).toBeDefined();
    expect(f?.resumenAprobacion(pendiente, 0).titulo).toBe(pendiente.question);
    expect(f?.tiempoRestante(301_000, 41_000)).toBe('Caduca en 4 min 20 s');
  });

  it('la página incluye ambos scripts válidos, botones claros y confirmación para «siempre»', () => {
    const html = renderPage();
    const bloques = scripts(html);
    expect(bloques.length).toBe(2);
    for (const bloque of bloques) expect(() => new Function(bloque)).not.toThrow();
    expect(html).toContain('Permitir una vez');
    expect(html).toContain('Permitir por ahora');
    expect(html).toContain('Denegar');
    expect(html).toContain('window.confirm(');
    expect(html).toContain('cargarAprobacionesEnSilencio');
  });
});
