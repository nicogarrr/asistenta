import { describe, expect, it } from 'vitest';
import { parseRenfeResults } from '../src/tools/renfe.js';

// «Precio desde» solo se leía con un espacio normal antes de «€» y con céntimos: con
// `&nbsp;` (U+00A0) o el espacio fino, un precio entero («59 €») o sin punto de miles
// («1299,00 €») cada tren salía «sin precio visible».
const row = (salida: string, llegada: string, price: string) =>
  `${salida} h\n2 horas 30 minutos\n${llegada} h\nPrecio desde\n${price}\n`;

describe('parseRenfeResults: precio «desde»', () => {
  it('lee el precio con espacio duro o fino antes de «€»', () => {
    const trains = parseRenfeResults(
      row('06:27', '09:56', '99,60\u00a0€') + row('07:27', '10:11', '45,10\u202f€'),
    );
    expect(trains.map((t) => t.precioDesde)).toEqual(['99,60 €', '45,10 €']);
  });

  it('lee un precio entero y uno sin punto de miles', () => {
    const trains = parseRenfeResults(
      row('06:27', '09:56', '59 €') + row('08:00', '11:00', '1299,00 €'),
    );
    expect(trains.map((t) => t.precioDesde)).toEqual(['59 €', '1299,00 €']);
  });

  it('lo que ya se leía no cambia y lo raro sigue sin precio', () => {
    const trains = parseRenfeResults(
      row('06:27', '09:56', '1.198,70 €') +
        row('08:00', '11:00', '99,6 €') +
        row('09:00', '12:00', '12,50 $'),
    );
    expect(trains.map((t) => t.precioDesde)).toEqual(['1.198,70 €', null, null]);
  });
});
