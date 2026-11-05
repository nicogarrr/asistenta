import { describe, expect, it } from 'vitest';
import { factKey, statedFact } from '../src/memory/owner-facts.js';

/**
 * agente-2: un dato con una coma («mi dentista es el Dr. García, en Getafe») no se
 * apuntaba nunca: cualquier coma hacía la frase «otro pedido». Una coma seguida de un
 * complemento sin petición es parte del dato; una coma seguida de un encargo
 * («…, ayúdame con el correo») sigue sin apuntarse.
 */
describe('statedFact: datos con coma', () => {
  it.each([
    ['mi dentista es el Dr. García, en Getafe', 'Mi dentista es el Dr. García, en Getafe'],
    [
      'mi médica es la Dra. Ruiz, del centro de salud de Getafe',
      'Mi médica es la Dra. Ruiz, del centro de salud de Getafe',
    ],
    ['mi hermana se llama Lucía, vive en Bilbao', 'Mi hermana se llama Lucía, vive en Bilbao'],
    ['me gusta el café solo, sin azúcar', 'Me gusta el café solo, sin azúcar'],
    [
      'soy alérgico a la penicilina, y a los frutos secos',
      'Soy alérgico a la penicilina, y a los frutos secos',
    ],
    ['mi jefe se llama Pedro, Pedro Sánchez', 'Mi jefe se llama Pedro, Pedro Sánchez'],
  ])('«%s» se apunta', (text, saved) => {
    expect(statedFact(text)).toBe(saved);
  });

  it('una coleta «apúntalo» o «guárdalo» no cambia el dato', () => {
    expect(statedFact('mi dentista es el Dr. García, apúntalo')).toBe(
      'Mi dentista es el Dr. García',
    );
    expect(statedFact('mi taller es Talleres Paco, guárdalo porfa')).toBe(
      'Mi taller es Talleres Paco',
    );
  });

  it.each([
    'no me escribas antes de las 9, ayúdame con el correo',
    'mi dentista es el Dr. García, pídeme cita',
    'mi jefe es Juan, mándale un correo',
    'mi jefe es Juan, escríbele que llego tarde',
    'mi hermana se llama Lucía, llama a su número',
    'mi coche es un Seat León, busca talleres cerca',
    'mi coche es un Seat León, puedes buscar talleres',
    'mi jefe es Juan, necesito que le escribas',
    'mi jefe es Juan, quiero que le mandes el informe',
    'mi dentista es el Dr. García, recuérdame llamarle',
    'mi dentista es el Dr. García, avísame el jueves',
    'mi dentista es el Dr. García, en Getafe, en la calle Mayor, junto al banco',
    'mi dentista es el Dr. García; en Getafe',
  ])('«%s» no se apunta', (text) => {
    expect(statedFact(text)).toBeNull();
  });

  it('el dato con coma sigue sustituyendo al viejo del mismo sujeto', () => {
    const fact = statedFact('mi dentista es el Dr. García, en Getafe');
    expect(fact).not.toBeNull();
    expect(factKey(fact ?? '')).toBe(factKey('Mi dentista es el Dr. López'));
  });
});
