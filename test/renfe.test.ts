import { describe, expect, it } from 'vitest';
import {
  filterAfter,
  formatTrains,
  judgeDay,
  madridDate,
  parseRenfeResults,
  parseTrainRow,
  parseTripDetail,
  renfeDate,
} from '../src/tools/renfe.js';

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

describe('renfeDate', () => {
  it('convierte a DD/MM/YYYY, el formato de la barra de días de Renfe', () => {
    expect(renfeDate('2026-10-06')).toBe('06/10/2026');
  });
});

describe('parseTrainRow', () => {
  it('lee salida, tipo y transbordos de las etiquetas de accesibilidad', () => {
    const row = parseTrainRow({
      labels: [
        'Tren con salida a las 18:57 y llegada a las 21:59.',
        'Duración 3 horas 2 minutos.',
        'Tren sin Transbordo.',
        'Tipo de tren: AVE.',
      ],
      text: 'accessible Solo plaza H disponible',
    });
    expect(row).toEqual({
      salida: '18:57',
      tipo: 'AVE',
      transbordos: 'sin transbordo',
      completo: false,
    });
  });

  it('marca Tren Completo y no inventa campos que no hay', () => {
    const row = parseTrainRow({ labels: [], text: 'railway_alert Tren Completo' });
    expect(row).toEqual({ completo: true });
  });
});

const DETAIL = `Detalles del trayecto
×
Itinerario
Prestaciones
03301
06:16
radio_button_checked
Madrid-Puerta De Atocha-Almudena Grandes
08:43
Camp De Tarragona
09:24
location_on
Barcelona-Sants
`;

describe('parseTripDetail', () => {
  it('saca estación de salida, de llegada y paradas, sin los nombres de iconos', () => {
    expect(parseTripDetail(DETAIL)).toEqual({
      estacionSalida: 'Madrid-Puerta De Atocha-Almudena Grandes',
      estacionLlegada: 'Barcelona-Sants',
      paradas: ['08:43 Camp De Tarragona'],
      horaSalida: '06:16',
      horaLlegada: '09:24',
    });
  });

  it('sin al menos dos paradas no afirma nada', () => {
    expect(parseTripDetail('Detalles del trayecto\n06:16\nMadrid')).toBeNull();
    expect(parseTripDetail('')).toBeNull();
  });
});

describe('formatTrains con los campos nuevos', () => {
  it('muestra estaciones, tipo, transbordos y completo cuando existen', () => {
    const out = formatTrains([
      {
        salida: '06:16',
        llegada: '09:24',
        duracion: '3 horas 8 minutos',
        precioDesde: '62,25 €',
        tipo: 'AVE',
        transbordos: 'sin transbordo',
        completo: true,
        estacionSalida: 'Madrid-Puerta De Atocha-Almudena Grandes',
        estacionLlegada: 'Barcelona-Sants',
      },
    ]);
    expect(out).toBe(
      '06:16 -> 09:24 Madrid-Puerta De Atocha-Almudena Grandes -> Barcelona-Sants (3 horas 8 minutos), desde 62,25 € [AVE, sin transbordo, COMPLETO]',
    );
  });
});

describe('judgeDay', () => {
  const base = {
    want: '06/10/2026',
    pressed: '06/10/2026',
    fingerprint: 'a|b',
    summaryDay: '06',
    clicked: false,
    fingerprintBefore: '',
  };

  it('acepta la lista del dia pedido', () => {
    expect(judgeDay(base)).toEqual({ ok: true });
  });

  it('sin dia marcado es desconocido, no se supone', () => {
    const v = judgeDay({ ...base, pressed: '' });
    expect(v).toMatchObject({ ok: false, reason: 'unknown-day' });
  });

  it('dia marcado distinto es dia equivocado (hoy en vez de mañana)', () => {
    expect(judgeDay({ ...base, pressed: '04/10/2026' })).toMatchObject({
      ok: false,
      reason: 'wrong-day',
    });
  });

  it('el resumen con otro dia del mes tambien rechaza, aunque la barra diga el pedido', () => {
    expect(judgeDay({ ...base, summaryDay: '04' })).toMatchObject({
      ok: false,
      reason: 'wrong-day',
    });
    expect(judgeDay({ ...base, summaryDay: '6' })).toEqual({ ok: true });
  });

  it('tras pulsar el dia la marca cambia antes que la lista: lista igual = no vale', () => {
    const stale = judgeDay({ ...base, clicked: true, fingerprintBefore: 'a|b' });
    expect(stale).toMatchObject({ ok: false, reason: 'stale-list' });
    expect(judgeDay({ ...base, clicked: true, fingerprintBefore: 'x|y' })).toEqual({ ok: true });
  });

  it('una lista vacia no vale', () => {
    expect(judgeDay({ ...base, fingerprint: '' })).toMatchObject({ ok: false });
  });
});
