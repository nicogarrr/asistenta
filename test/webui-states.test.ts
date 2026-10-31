import { describe, expect, it } from 'vitest';
import { mensajeDeError } from '../src/webui/client-format.js';
import { renderPage } from '../src/webui/page.js';

describe('panel: estados de error y de token', () => {
  it('usa el mensaje del servidor en vez de solo el código', () => {
    expect(mensajeDeError(503, { error: 'Objetivos aún no disponibles' })).toBe(
      'Objetivos aún no disponibles. Si el asistente está arrancando, reintenta en unos segundos.',
    );
    expect(mensajeDeError(404, { error: 'La aprobación ya no está pendiente' })).toBe(
      'La aprobación ya no está pendiente.',
    );
    expect(mensajeDeError(400, { error: 'Falta el texto del mensaje' })).toBe(
      'Falta el texto del mensaje.',
    );
  });

  it('un 500 explica qué hacer y no filtra detalles', () => {
    expect(mensajeDeError(500, { error: 'Error interno' })).toBe(
      'Algo ha fallado por mi parte. Vuelve a intentarlo en un momento.',
    );
    expect(mensajeDeError(502, null)).toContain('Algo ha fallado por mi parte');
  });

  it('401 pide el token y lo demás cae al código', () => {
    expect(mensajeDeError(401, { error: 'No autorizado' })).toBe(
      'Token rechazado. Pega el token correcto arriba.',
    );
    expect(mensajeDeError(418, 'texto')).toBe('El panel respondió con el código 418.');
  });

  it('la página ofrece pegar el token, reintentar cada sección y no dice «Actualizado» si falló', () => {
    const html = renderPage();
    expect(html).toContain('id="form-token"');
    expect(html).toContain('type="password"');
    expect(html).toContain("'Reintentar'");
    expect(html).toContain('formato.mensajeDeError(respuesta.status, datos)');
    expect(html).toContain("' con error · '");
    for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      expect(() => new Function(m[1] ?? '')).not.toThrow();
    }
  });
});
