import { describe, expect, it } from 'vitest';
import type { RoutineTrigger } from '../src/db.js';
import { mailMatches, matchesTrigger } from '../src/triggers.js';

// bugs29: los disparadores comparaban con tildes: «de telefónica» no casaba con
// «Telefonica <factura@telefonica.es>», ni «asunto facturación» con «Facturacion de octubre»
// (ni «mensaje factura» escrito al revés), así que no saltaban nunca.
describe('disparadores sin depender de las tildes (bugs29)', () => {
  it('correo: remitente y asunto', () => {
    const tef = { from: 'Telefonica <factura@telefonica.es>', subject: 'Facturacion de octubre' };
    expect(mailMatches('de telefónica', tef)).toBe(true);
    expect(mailMatches('asunto facturación', tef)).toBe(true);
    expect(mailMatches('de movistar', tef)).toBe(false);
    const aeat = { from: 'Agencia Tributaria <x@aeat.es>', subject: 'Notificación pendiente' };
    expect(mailMatches('asunto notificacion', aeat)).toBe(true);
  });

  it('mensaje y archivo', () => {
    const t = {
      id: 1,
      scope: 'chat',
      event: 'mensaje',
      match: 'facturación',
      routine: 'archiva',
      args: null,
      enabled: true,
    } as unknown as RoutineTrigger;
    expect(
      matchesTrigger(t, { type: 'mensaje', scope: 'chat', text: 'ahí va la facturacion' }),
    ).toBe(true);
    expect(matchesTrigger(t, { type: 'mensaje', scope: 'chat', text: 'nada que ver' })).toBe(false);
  });
});
