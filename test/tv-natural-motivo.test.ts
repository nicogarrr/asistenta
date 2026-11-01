import { describe, expect, it } from 'vitest';
import { parseTvCommand } from '../src/tv/natural.js';

// «sube el volumen que no se oye» o «pausa que voy al baño» iban al modelo (y
// fallaban si el modelo no respondía). El motivo detrás de «que» no cambia la orden.
describe('orden con su motivo: «… que no se oye»', () => {
  it.each([
    ['sube el volumen que no se oye', { action: 'volumeStep', steps: 3 }],
    ['baja el volumen que esta muy alto', { action: 'volumeStep', steps: -3 }],
    ['baja el volumen porque esta alto', { action: 'volumeStep', steps: -3 }],
    ['sube un poco que no se oye nada', { action: 'volumeStep', steps: 3 }],
    ['pausa que voy al baño', { action: 'media', command: 'pause' }],
    ['para un momento que vuelvo', { action: 'media', command: 'pause' }],
    ['pausa xq me llaman', { action: 'media', command: 'pause' }],
  ])('«%s»', (text, intent) => {
    expect(parseTvCommand(text)).toEqual(intent);
  });

  it.each([
    'sube el volumen que tenia antes',
    'pon la peli que estaba viendo',
    'cambia al canal que echan el partido',
    'pausa que vuelvo en 5 minutos',
    'sube el volumen que te digo que pongas netflix',
    'por que no sube el volumen',
    'la tele no se oye que pasa',
    'pon la tele que empieza el partido',
    'pon la tele que voy a ver una peli',
  ])('«%s» sigue yendo al modelo', (text) => {
    expect(parseTvCommand(text)).toBeNull();
  });
});
