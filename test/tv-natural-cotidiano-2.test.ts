import { describe, expect, it } from 'vitest';
import { parseTvCommand } from '../src/tv/natural.js';

describe('más frases de tele sin modelo', () => {
  it.each([
    ['pausa un momento', { action: 'media', command: 'pause' }],
    ['para un segundo', { action: 'media', command: 'pause' }],
    ['pausa ahí', { action: 'media', command: 'pause' }],
    ['pausa un momentito', { action: 'media', command: 'pause' }],
    ['volumen veinte', { action: 'volume', level: 20 }],
    ['pon el volumen quince', { action: 'volume', level: 15 }],
  ])('«%s»', (text, intent) => {
    expect(parseTvCommand(text)).toEqual(intent);
  });

  it('lo de siempre no cambia', () => {
    expect(parseTvCommand('volumen 10')).toEqual({ action: 'volume', level: 10 });
    expect(parseTvCommand('volumen arriba')).toEqual({ action: 'volumeStep', steps: 3 });
    expect(parseTvCommand('volumen mas')).toEqual({ action: 'volumeStep', steps: 3 });
    expect(parseTvCommand('espera un momento')).toBeNull();
  });
});
