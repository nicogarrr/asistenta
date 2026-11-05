import { describe, expect, it } from 'vitest';
import { mailMatches, parseMailMatch } from '../src/triggers.js';

// bugs28: «de renfe o iberia» pedía las dos palabras a la vez (y buscaba «o» como texto),
// así que un aviso de correo con alternativas no saltaba nunca.
describe('disparador de correo con alternativas («o»)', () => {
  const renfe = { from: 'Renfe Viajeros <venta@renfe.es>', subject: 'Tu billete' };
  const iberia = { from: 'Iberia <no-reply@iberia.com>', subject: 'Tarjeta de embarque' };
  const otro = { from: 'Amazon <envios@amazon.es>', subject: 'Tu pedido' };

  it('«de renfe o iberia»: vale cualquiera de los dos remitentes', () => {
    expect(mailMatches('de renfe o iberia', renfe)).toBe(true);
    expect(mailMatches('de renfe o iberia', iberia)).toBe(true);
    expect(mailMatches('de renfe o iberia', otro)).toBe(false);
  });

  it('«de renfe o de iberia» y «de:renfe o de:iberia» igual', () => {
    for (const m of ['de renfe o de iberia', 'de:renfe o de:iberia', 'del banco o de iberia']) {
      expect(mailMatches(m, iberia), m).toBe(true);
      expect(mailMatches(m, otro), m).toBe(false);
    }
  });

  it('lista con comas que acaba en «o»: «de renfe, iberia o ouigo»', () => {
    const ouigo = { from: 'OUIGO <hola@ouigo.es>', subject: 'Confirmación' };
    const m = 'de renfe, iberia o ouigo';
    expect(mailMatches(m, ouigo)).toBe(true);
    expect(mailMatches(m, renfe)).toBe(true);
    expect(mailMatches(m, otro)).toBe(false);
  });

  it('texto suelto: «billete o embarque» en el asunto', () => {
    expect(mailMatches('billete o embarque', renfe)).toBe(true);
    expect(mailMatches('billete o embarque', iberia)).toBe(true);
    expect(mailMatches('billete o embarque', otro)).toBe(false);
  });

  it('remitente y alternativa en el asunto: «de renfe, asunto billete o factura»', () => {
    const factura = { from: 'Renfe <venta@renfe.es>', subject: 'Factura de tu viaje' };
    expect(mailMatches('de renfe asunto billete o factura', factura)).toBe(true);
    expect(mailMatches('de renfe asunto billete o factura', renfe)).toBe(true);
    expect(mailMatches('de renfe asunto billete o factura', iberia)).toBe(false);
  });

  it('«o» nunca se busca como texto y lo que no tiene «o» sigue igual', () => {
    expect(parseMailMatch('de renfe o iberia').any).toEqual([]);
    expect(parseMailMatch('de renfe con billete')).toEqual({
      from: ['renfe'],
      subject: [],
      any: ['billete'],
    });
    // Dentro de comillas «o» es parte de la frase.
    expect(parseMailMatch('asunto:"ida o vuelta"').subject).toEqual(['ida o vuelta']);
    // «de renfe, urgente»: la coma sin «o» al final sigue siendo «y».
    expect(mailMatches('de renfe, urgente', renfe)).toBe(false);
  });
});
