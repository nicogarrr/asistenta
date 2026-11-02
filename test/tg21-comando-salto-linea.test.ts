/**
 * «/nota» con el texto en la línea siguiente (Intro en el móvil) no se reconocía como
 * comando: el salto de línea no contaba como separador y el mensaje entero le llegaba al
 * modelo como texto suelto. Ahora cualquier espacio en blanco separa el comando.
 */
import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/cli.js';

describe('comando seguido de salto de línea', () => {
  it('«/nota» + Intro + texto es el comando con su texto', () => {
    expect(parseCommand('/nota\ncomprar pan\ny leche')).toEqual({
      name: 'nota',
      args: 'comprar pan\ny leche',
    });
    expect(parseCommand('/recordar\tmañana a las 9')).toEqual({
      name: 'recordar',
      args: 'mañana a las 9',
    });
    expect(parseCommand('/estado@asistenta_bot\nya')).toEqual({ name: 'estado', args: 'ya' });
  });

  it('lo de siempre no cambia', () => {
    expect(parseCommand('/nota comprar pan')).toEqual({ name: 'nota', args: 'comprar pan' });
    expect(parseCommand('/estado')).toEqual({ name: 'estado', args: '' });
    expect(parseCommand('hola /nota')).toBeNull();
    expect(parseCommand('/123')).toBeNull();
  });
});
