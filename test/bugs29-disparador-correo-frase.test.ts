import { describe, expect, it } from 'vitest';
import { mailMatches, parseMailMatch } from '../src/triggers.js';

// bugs29: «/disparador correo que diga urgente | …» o «con la palabra urgente» buscaban también
// «diga» o «palabra» en el correo, y no saltaba nunca; «de la Agencia Tributaria» buscaba el
// remitente «la».
describe('disparador de correo dicho normal (bugs29)', () => {
  it('«que diga», «con la palabra», «que ponga» no se buscan', () => {
    const mail = { from: 'Proveedor <a@b.com>', subject: 'URGENTE: revisar el pedido' };
    expect(mailMatches('que diga urgente', mail)).toBe(true);
    expect(mailMatches('con la palabra urgente', mail)).toBe(true);
    expect(mailMatches('que ponga urgente', mail)).toBe(true);
    expect(mailMatches('que diga factura', mail)).toBe(false);
  });

  it('«de la …», «de mi …»: el remitente es la palabra de detrás', () => {
    expect(parseMailMatch('de la Agencia Tributaria').from).toEqual(['agencia']);
    const aeat = {
      from: 'Agencia Tributaria <notificaciones@agenciatributaria.gob.es>',
      subject: 'Notificación',
    };
    expect(mailMatches('de la Agencia Tributaria', aeat)).toBe(true);
    expect(
      mailMatches('de la agencia tributaria', { from: 'Clara <c@x.es>', subject: 'hola' }),
    ).toBe(false);
    // Lo que ya iba sigue igual.
    expect(parseMailMatch('de renfe o iberia').from).toEqual(['renfe|iberia']);
    expect(parseMailMatch('de correos').from).toEqual(['correos']);
    expect(parseMailMatch('asunto factura').subject).toEqual(['factura']);
  });
});
