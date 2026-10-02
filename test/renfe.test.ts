import { describe, expect, it } from 'vitest';
import { filterAfter, formatTrains, madridDate, parseRenfeResults } from '../src/tools/renfe.js';

const PAGE = `Selecciona tu viaje
Mié
30
Dom
04
59€
tuneFiltrar
06:27 h
3 horas 29 minutos
09:56 h
Precio desde
99,60 €
    Plaza H disponible  Cero emisiones
07:27 h
3 horas 44 minutos
11:11 h
accessible Solo plaza H disponible
15:27 h
3 horas 47 minutos
19:14 h
Precio desde
1.198,70 €
16:27 h
3 horas 17 minutos
19:44 h
Precio desde
99,60 €
`;

describe('parseRenfeResults', () => {
  it('extrae salida, llegada, duración y precio; sin precio queda null', () => {
    const trains = parseRenfeResults(PAGE);
    expect(trains).toHaveLength(4);
    expect(trains[0]).toEqual({
      salida: '06:27',
      llegada: '09:56',
      duracion: '3 horas 29 minutos',
      precioDesde: '99,60 €',
    });
    expect(trains[1]?.precioDesde).toBeNull();
    expect(trains[2]?.precioDesde).toBe('1.198,70 €');
  });

  it('el calendario previo a los resultados no genera trenes falsos', () => {
    expect(parseRenfeResults('Mié\n30\nJue\n01\n50€')).toEqual([]);
  });
});

describe('filterAfter y formato', () => {
  it('filtra por hora de salida', () => {
    const trains = parseRenfeResults(PAGE);
    expect(filterAfter(trains, '15:00').map((t) => t.salida)).toEqual(['15:27', '16:27']);
    expect(filterAfter(trains, undefined)).toHaveLength(4);
    expect(filterAfter(trains, '23:00')).toEqual([]);
  });

  it('formatea una línea por tren', () => {
    const out = formatTrains(parseRenfeResults(PAGE).slice(0, 2));
    expect(out).toContain('06:27 -> 09:56 (3 horas 29 minutos), desde 99,60 €');
    expect(out).toContain('sin precio visible');
  });
});

describe('madridDate', () => {
  it('00:33 de Madrid del 3/10 sigue siendo 2026-10-03 aunque en UTC sea el 2', () => {
    expect(madridDate(new Date('2026-10-02T22:33:00Z'))).toBe('2026-10-03');
  });
});
