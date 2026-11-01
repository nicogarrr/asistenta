import { describe, expect, it } from 'vitest';
import { looksLikeCorrection } from '../src/memory/learned-rules.js';

describe('más formas de corregir', () => {
  it.each([
    'Te has equivocado, la reunión era el martes',
    'te has confundido de Ana',
    'Te has colado, eran las 5',
    'te confundes, no es esa calle',
    'No es eso, quería el resumen corto',
    'no hace falta que me lo confirmes cada vez',
    'No necesito que me pongas el enlace',
    'no quiero que me respondas con listas',
    'Mejor no uses emojis',
    'Recuerda que siempre quiero la hora en formato 24 h',
    'acuérdate de que nunca le escribo a Pedro por la mañana',
    'cada vez que te pida un resumen, que sea en tres líneas',
    'háblame de tú',
    'Tutéame, porfa',
    'no me hables de usted',
  ])('«%s» cuenta como corrección', (text) => {
    expect(looksLikeCorrection(text)).toBe(true);
  });

  it.each([
    'recuérdame mañana a las 9 llamar a mamá',
    'Recuerda que mañana tengo médico',
    '¿qué es eso que sale en la pantalla?',
    'busca vuelos a Roma para la próxima semana',
    '¿hace falta que lleve paraguas?',
    'no quiero que llueva el sábado',
    'apaga la tele',
    'mándale un correo a Ana con el informe',
    '¿te acuerdas de lo que hablamos ayer?',
    'mejor el martes que el lunes',
    '¿cada cuánto pasa el autobús?',
    'pon un recordatorio para hablar con Tú y Yo, la tienda',
    'Ustedes qué opinan',
  ])('«%s» no cuenta como corrección', (text) => {
    expect(looksLikeCorrection(text)).toBe(false);
  });
});
