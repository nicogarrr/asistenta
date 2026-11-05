import { describe, expect, it } from 'vitest';
import { mailMatches, parseMailMatch } from '../src/triggers.js';

const renfe = { from: 'billetes@renfe.com', subject: 'Confirmación: billete Madrid-Valencia' };
const banco = {
  from: 'Banco Sabadell <avisos@bancsabadell.com>',
  subject: 'Movimiento en tu cuenta',
};

describe('disparador de correo dicho normal', () => {
  it('«de renfe» / «del banco» sin dos puntos son el remitente, no la palabra «de»', () => {
    expect(parseMailMatch('de renfe')).toEqual({ from: ['renfe'], subject: [], any: [] });
    expect(mailMatches('de renfe', renfe)).toBe(true);
    expect(mailMatches('del banco', banco)).toBe(true);
    expect(mailMatches('asunto billete', renfe)).toBe(true);
  });

  it('las palabras de enlace y la coma pegada no se buscan', () => {
    expect(mailMatches('de renfe con billete', renfe)).toBe(true);
    expect(mailMatches('de renfe, asunto billete', renfe)).toBe(true);
    expect(mailMatches('correo de renfe', renfe)).toBe(false); // «correo» sí se busca
  });

  it('lo de siempre no cambia', () => {
    expect(parseMailMatch('de:renfe asunto:billete')).toEqual({
      from: ['renfe'],
      subject: ['billete'],
      any: [],
    });
    expect(parseMailMatch('asunto: “billete de tren”').subject).toEqual(['billete de tren']);
    expect(mailMatches('de:renfe asunto:factura', renfe)).toBe(false);
    expect(mailMatches('de banco', renfe)).toBe(false);
    // «de» en medio no es el remitente: «billete de tren» busca las palabras en el correo.
    expect(
      mailMatches('billete de tren', { from: 'x@renfe.com', subject: 'Tu billete de tren' }),
    ).toBe(true);
    expect(mailMatches('', renfe)).toBe(false);
  });
});
