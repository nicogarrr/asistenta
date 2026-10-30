import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { etiquetaCampo, formatearCampo } from '../src/webui/client-format.js';
import { renderFormatScript, renderPage } from '../src/webui/page.js';

const ZONA = 'Europe/Madrid';

describe('panel: fechas, duraciones y etiquetas legibles', () => {
  it('un epoch en ms de un campo «…At» sale como fecha en español, no como número', () => {
    expect(formatearCampo('createdAt', Date.UTC(2026, 9, 30, 12, 21), ZONA)).toBe(
      '30 oct 2026, 13:21',
    );
    expect(formatearCampo('expiresAt', Date.UTC(2026, 9, 30, 12, 21) / 1000, ZONA)).toBe(
      '30 oct 2026, 13:21',
    );
    expect(formatearCampo('updatedAt', '2026-10-30T12:21:00.000Z', ZONA)).toBe(
      '30 oct 2026, 13:21',
    );
    expect(formatearCampo('updated_at', '2026-03-29T00:30:00Z', ZONA)).toBe('29 mar 2026, 1:30');
  });

  it('no toca lo que no es una fecha', () => {
    expect(formatearCampo('createdAt', 42, ZONA)).toBeNull();
    expect(formatearCampo('createdAt', 'ayer', ZONA)).toBeNull();
    expect(formatearCampo('count', 1_793_362_855_356, ZONA)).toBeNull();
    expect(formatearCampo('title', '2026-10-30', ZONA)).toBeNull();
  });

  it('las duraciones en segundos salen en días, horas y minutos', () => {
    expect(formatearCampo('uptimeSeconds', 93_784)).toBe('1 d 2 h 3 min');
    expect(formatearCampo('uptimeSeconds', 3_720)).toBe('1 h 2 min');
    expect(formatearCampo('uptimeSeconds', 75)).toBe('1 min 15 s');
    expect(formatearCampo('durationMs', 4_000)).toBe('4 s');
  });

  it('las claves del estado salen en español', () => {
    expect(etiquetaCampo('model')).toBe('Modelo');
    expect(etiquetaCampo('provider')).toBe('Proveedor');
    expect(etiquetaCampo('uptimeSeconds')).toBe('Tiempo encendido');
    expect(etiquetaCampo('expiresAt')).toBe('Caduca');
    expect(etiquetaCampo('lastRunAt')).toBe('Last Run At');
  });

  it('la copia del navegador formatea igual y la página la usa', () => {
    const ctx: { asistentaFormato?: { formatearCampo: typeof formatearCampo } } = {};
    runInNewContext(
      renderFormatScript().replace('var asistentaFormato', 'this.asistentaFormato'),
      ctx,
    );
    expect(ctx.asistentaFormato?.formatearCampo('uptimeSeconds', 93_784)).toBe('1 d 2 h 3 min');
    const html = renderPage();
    expect(html).toContain('formato.formatearCampo(clave, valor)');
    expect(html).toContain('placeholder="local"');
    expect(html).not.toContain('placeholder="global"');
  });
});
