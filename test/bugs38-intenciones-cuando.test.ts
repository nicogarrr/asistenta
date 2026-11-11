import { describe, expect, it } from 'vitest';
import { intencionIntent, mencionaClave } from '../src/intenciones.js';

// bugs-38: «cuando hable con Marta mañana, recuérdame darle el libro» guardaba el tema
// «Marta mañana», que no sale nunca en lo que escribe («he quedado con Marta»): el recordatorio
// no saltaba jamás. Lo de cuándo («mañana», «el lunes», «esta tarde», «por teléfono») no es
// parte del tema.
describe('intencionIntent: el cuándo no es parte del tema', () => {
  it.each([
    ['cuando hable con Marta mañana, recuérdame darle el libro', ['Marta'], 'darle el libro'],
    ['si hablo con Pedro esta tarde recuérdame pedirle el IBAN', ['Pedro'], 'pedirle el IBAN'],
    [
      'cuando hable con el banco el lunes, recuérdame lo de la hipoteca',
      ['banco'],
      'lo de la hipoteca',
    ],
    ['cuando hable con Ana por teléfono, pregúntame por su viaje', ['Ana'], 'su viaje'],
    ['recuérdame darle el libro cuando hable con Marta mañana', ['Marta'], 'darle el libro'],
    [
      'cuando hable de Indra otra vez, recuérdame mirar el dividendo',
      ['Indra'],
      'mirar el dividendo',
    ],
  ])('%s', (frase, claves, texto) => {
    const r = intencionIntent(frase);
    expect(r).toEqual({ claves, texto });
    expect(
      mencionaClave('he quedado con Marta y Pedro, Ana, el banco e Indra', r?.claves[0] ?? ''),
    ).toBe(true);
  });

  it('un tema que es solo eso sigue igual («la hipoteca del piso»)', () => {
    expect(
      intencionIntent('cuando hable de la hipoteca del piso, recuérdame llamar al banco')?.claves,
    ).toEqual(['hipoteca del piso']);
  });
});
