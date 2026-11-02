import { describe, expect, it } from 'vitest';
import { type LuzHour, luzText } from '../src/tools/luz.js';

// bugs16: un tramo que acaba a medianoche salía «de 22 a 0 h» o «23–0 h». Se dice 24.
// Día 2026-11-03 en Madrid (UTC+1): la hora local h empieza a las (h-1):00 UTC.
const day = '2026-11-03';
const at = (h: number): Date => new Date(Date.UTC(2026, 10, 2, 23 + h));
const hours: LuzHour[] = Array.from({ length: 24 }, (_, h) => ({
  at: at(h),
  // Lo más barato al final del día; lo más caro, la última hora.
  price: h >= 21 && h <= 22 ? 0.01 : h === 23 ? 0.3 : 0.1 + h / 1000,
}));

describe('luz: un tramo que acaba a medianoche', () => {
  it('dice «24», no «0»', () => {
    const out = luzText(hours, { day, isToday: false, now: at(0) });
    expect(out).toContain('la más cara: 23–24 h');
    expect(out).not.toMatch(/a 0 h|–0 h/);
    const cheapLate = hours.map((h, i) => ({ ...h, price: i >= 22 ? 0.001 : 0.2 }));
    const late = luzText(cheapLate, { day, isToday: false, now: at(0), horas: 2 });
    expect(late).toContain('Horas más baratas: de 0 a 4 h y de 22 a 24 h');
    expect(late).toContain('Para 2 horas seguidas: de 22 a 24 h');
    expect(late).not.toMatch(/a 0 h|–0 h/);
  });

  it('un tramo que empieza a medianoche sigue diciendo «0»', () => {
    const cheapFirst = hours.map((h, i) => ({ ...h, price: i === 0 ? 0.001 : 0.2 }));
    const out = luzText(cheapFirst, { day, isToday: false, now: at(0) });
    expect(out).toContain('La más barata: 0–1 h');
  });
});
