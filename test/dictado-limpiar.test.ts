import { describe, expect, it } from 'vitest';
import { ajustesDictado, parseTeclaDictado } from '../src/dictado/ajustes.js';
import { limpiarDictado } from '../src/dictado/limpiar.js';

describe('limpiarDictado', () => {
  const casos: Array<[string, string]> = [
    [
      'hola eh qué tal coma te escribo por lo de mañana punto',
      'Hola qué tal, te escribo por lo de mañana.',
    ],
    [' Hola, coma, qué tal. Punto.', 'Hola, qué tal.'],
    ['eh, o sea, quiero que se coma la tarta punto', 'Quiero que se coma la tarta.'],
    [
      'nos vemos en el punto de encuentro punto y aparte gracias',
      'Nos vemos en el punto de encuentro.\n\nGracias',
    ],
    ['abre interrogación vienes mañana cierra interrogación', '¿Vienes mañana?'],
    ['lista dos puntos pan coma leche coma huevos', 'Lista: pan, leche, huevos'],
    ['primero nueva línea segundo', 'Primero\nSegundo'],
    ['eso es un punto a favor coma creo', 'Eso es un punto a favor, creo'],
    ['vale punto y seguido luego te llamo', 'Vale. Luego te llamo'],
    ['espera abre paréntesis cinco minutos cierra paréntesis', 'Espera (cinco minutos)'],
    ['mmm em', ''],
    ['hemos hablado del tema', 'Hemos hablado del tema'],
  ];
  for (const [dicho, escrito] of casos) {
    it(JSON.stringify(dicho), () => expect(limpiarDictado(dicho)).toBe(escrito));
  }
});

describe('ajustes del dictado', () => {
  it('apagado por defecto', () => {
    const a = ajustesDictado({});
    expect(a).toMatchObject({ activo: false, teclaTexto: 'ctrl+win' });
    expect(a.tecla).toEqual([[0x11], [0x5b, 0x5c]]);
  });

  it('PA_DICTADO=sí lo enciende', () => {
    expect(ajustesDictado({ PA_DICTADO: 'sí' }).activo).toBe(true);
  });

  it('teclas válidas y no válidas', () => {
    expect(parseTeclaDictado('Ctrl + Alt')).toEqual([[0x11], [0x12]]);
    expect(parseTeclaDictado('F9')).toEqual([[0x78]]);
    expect(parseTeclaDictado('ctrl')).toBeNull();
    expect(parseTeclaDictado('ctrl+q')).toBeNull();
    expect(parseTeclaDictado('')).toBeNull();
    expect(ajustesDictado({ PA_DICTADO_TECLA: 'patata' }).tecla).toBeNull();
  });
});
