import { describe, expect, it } from 'vitest';
import { latidoHasta, latidoListRequest, latidoStopRequest } from '../src/daemon/latido.js';

const tz = 'Europe/Madrid';
const now = new Date('2026-11-05T21:00:00Z'); // 22:00 en Madrid
const local = (d: Date | null): string =>
  d ? d.toLocaleString('es-ES', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }) : 'null';

describe('vigilar: «hasta mañana a las 9» y más formas de parar o ver', () => {
  it('«hasta mañana a las 9» es mañana a las 9 (antes se volvía a preguntar)', () => {
    expect(local(latidoHasta('hasta mañana a las 9', now, tz))).toBe('6/11/26, 9:00');
    expect(local(latidoHasta('hasta mañana las 8', now, tz))).toBe('6/11/26, 8:00');
    expect(local(latidoHasta('hasta pasado mañana a las 10', now, tz))).toBe('7/11/26, 10:00');
    expect(local(latidoHasta('hasta las 23', now, tz))).toBe('5/11/26, 23:00');
  });

  it('«cancela la vigilancia», «ya no vigiles», «quita la vigilancia de la web» paran', () => {
    expect(latidoStopRequest('cancela la vigilancia')).toBe('');
    expect(latidoStopRequest('ya no vigiles')).toBe('');
    expect(latidoStopRequest('para la vigilancia')).toBe('');
    expect(latidoStopRequest('borra el latido')).toBe('');
    expect(latidoStopRequest('quita la vigilancia de la web')).toBe('web');
  });

  it('«¿qué vigilancias tengo?» y «mis vigilancias» enseñan la lista', () => {
    expect(latidoListRequest('¿qué vigilancias tengo?')).toBe(true);
    expect(latidoListRequest('mis vigilancias')).toBe(true);
  });
});
