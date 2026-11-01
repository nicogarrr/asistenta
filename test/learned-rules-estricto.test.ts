import { describe, expect, it } from 'vitest';
import { looksLikeCorrection } from '../src/memory/learned-rules.js';

describe('frases corrientes que no son correcciones', () => {
  it.each([
    'eso no lo sé, la verdad',
    'Eso no me lo esperaba',
    'eso no importa ahora',
    '¿y eso no es caro?',
    'si es así no pasa nada',
    'así no hay quien duerma con este ruido',
    'mi madre está mal, llámala luego',
    'el coche está mal aparcado',
    'no deja de llover en Madrid',
    '¿cuándo deja de sonar la alarma?',
    'la próxima vez que vaya a Madrid quiero ver el Prado',
    '¿cuándo es la próxima vez que juega el Betis?',
  ])('«%s» no cuenta como corrección', (text) => {
    expect(looksLikeCorrection(text)).toBe(false);
  });
});

describe('las correcciones de siempre siguen contando', () => {
  it.each([
    'eso no',
    'Eso no, quería el otro',
    'eso no es lo que te pedí',
    'eso no me sirve',
    'así no.',
    'así no me gusta',
    'No, así no',
    'eso está mal',
    'Está mal',
    'está mal calculado, son 40',
    'deja de ponerme emojis',
    'oye, deja de mandarme audios',
    'y deja de contestar con listas',
    'la próxima vez avísame antes',
    'la próxima vez, más corto',
    'para la próxima vez que te pida un resumen, que sea corto',
    'la próxima vez no me preguntes',
  ])('«%s» cuenta como corrección', (text) => {
    expect(looksLikeCorrection(text)).toBe(true);
  });
});
