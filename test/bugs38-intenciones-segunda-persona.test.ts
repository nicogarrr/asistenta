import { describe, expect, it } from 'vitest';
import { intencionIntent } from '../src/intenciones.js';

// bugs-38: «cuando hables con el banco, dime qué te dicen» es un encargo para Asistenta (que me
// cuente lo que le diga el banco), no un recordatorio por tema que salte cuando Nico hable del
// banco. Solo vale la 1ª persona (lo que dispara es que lo diga él).
describe('intencionIntent: la 2ª persona no es un recordatorio por tema', () => {
  it('«cuando hables con el banco, dime qué te dicen» → null', () => {
    expect(intencionIntent('cuando hables con el banco, dime qué te dicen')).toBeNull();
    expect(intencionIntent('Cuando hables con Marta, avísame de lo que diga')).toBeNull();
    expect(intencionIntent('si mencionas a Ana, pregúntame por su viaje')).toBeNull();
    expect(intencionIntent('si menciones la hipoteca, dime el tipo')).toBeNull();
    expect(intencionIntent('recuérdame llamar al banco cuando hables con Pedro')).toBeNull();
  });

  it('la 1ª persona sigue valiendo (singular y «hablemos»)', () => {
    expect(intencionIntent('cuando hable con el banco, recuérdame pedir el IBAN')).toEqual({
      claves: ['banco'],
      texto: 'pedir el IBAN',
    });
    expect(intencionIntent('cuando hablemos de Indra, recuérdame mirar el dividendo')).toEqual({
      claves: ['Indra'],
      texto: 'mirar el dividendo',
    });
    expect(
      intencionIntent('cuando te hable de Indra, recuérdame mirar el dividendo')?.claves,
    ).toEqual(['Indra']);
  });
});
