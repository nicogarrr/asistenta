import { describe, expect, it } from 'vitest';
import { parseFechaCalendario } from '../src/agenda/fecha-natural.js';

// /calendario «el viernes a la una de la noche» quedaba a las 13:00: «de la noche»
// sumaba 12 a cualquier hora menor de 12. La una, las dos… «de la noche» son de
// madrugada de la noche de ese día, como ya lo lee la agenda del correo (y como
// «a las 12 de la noche»).
const NOW = new Date('2026-11-01T10:00:00Z'); // domingo 1 nov, 11:00 en Madrid
const TZ = 'Europe/Madrid';

function said(text: string): string | null {
  const r = parseFechaCalendario(text, NOW, TZ);
  if (!r) return null;
  const at = r.start.toLocaleString('sv-SE', { timeZone: TZ }).slice(0, 16);
  return `${at} | ${r.title}`;
}

describe('/calendario: la una, las dos… «de la noche»', () => {
  it('es de madrugada, en la noche de ese día', () => {
    expect(said('el viernes a la una de la noche fiesta')).toBe('2026-11-07 01:00 | fiesta');
    expect(said('mañana a las 2 de la noche guardia')).toBe('2026-11-03 02:00 | guardia');
    expect(said('el 5 de noviembre a las 3:30 de la noche vuelo')).toBe('2026-11-06 03:30 | vuelo');
  });

  it('lo demás sigue igual', () => {
    expect(said('mañana a las 11 de la noche cena')).toBe('2026-11-02 23:00 | cena');
    expect(said('mañana a las 9 de la noche cine')).toBe('2026-11-02 21:00 | cine');
    expect(said('mañana a las 12 de la noche tren')).toBe('2026-11-03 00:00 | tren');
    expect(said('mañana a la una de la madrugada tren')).toBe('2026-11-02 01:00 | tren');
    expect(said('mañana a la una comida')).toBe('2026-11-02 13:00 | comida');
  });
});
