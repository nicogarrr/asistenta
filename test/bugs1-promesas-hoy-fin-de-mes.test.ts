import { describe, expect, it } from 'vitest';
import { estimateDueAt, hasDateSignal } from '../src/alerts/due.js';

// asis-bugs-1: «vence hoy», «en dos días» (en palabras) y «a fin de mes» caían en el
// «dentro de una semana» por defecto, así que el aviso de la promesa llegaba DESPUÉS del
// plazo que había dicho el dueño (justo lo que due.ts quiere evitar).
const DAY = 86_400_000;
// Sábado 28 de noviembre de 2026, 10:00 en Madrid.
const now = Date.UTC(2026, 10, 28, 9, 0);
const madrid = (at: number) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(new Date(at));

describe('promesas con fecha: hoy, números en palabras y fin de mes', () => {
  it('«hoy» y «esta noche» son hoy, no dentro de una semana', () => {
    expect(estimateDueAt('el seguro vence hoy', now)).toBe(now);
    expect(estimateDueAt('tengo que mandarlo antes de esta noche', now)).toBe(now);
  });

  it('un día nombrado gana a «hoy»', () => {
    expect(madrid(estimateDueAt('hoy he visto que vence el 3 de diciembre', now))).toBe(
      '2026-12-03',
    );
  });

  it('«en dos días» y «dentro de una semana» en palabras', () => {
    expect(estimateDueAt('vence en dos días', now)).toBe(now + 2 * DAY);
    expect(estimateDueAt('lo pago dentro de tres días', now)).toBe(now + 3 * DAY);
    expect(madrid(estimateDueAt('vence dentro de una semana', now))).toBe('2026-12-05');
    expect(hasDateSignal('lo pago dentro de dos días')).toBe(true);
    expect(estimateDueAt('vence en 4 días', now)).toBe(now + 4 * DAY);
  });

  it('«a fin de mes» es el último día de este mes', () => {
    expect(madrid(estimateDueAt('vence a fin de mes', now))).toBe('2026-11-30');
    expect(madrid(estimateDueAt('antes de final de mes pago el alquiler', now))).toBe('2026-11-30');
  });

  it('sin nada que fechar sigue siendo una semana', () => {
    expect(estimateDueAt('vence pronto', now)).toBe(now + 7 * DAY);
  });
});
