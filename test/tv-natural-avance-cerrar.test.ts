import { describe, expect, it } from 'vitest';
import { describeTvIntent, parseTvCommand } from '../src/tv/natural.js';

describe('tele: «adelanta» y «rebobina» por voz', () => {
  it.each([
    ['adelanta', 'fastForward'],
    ['avanza', 'fastForward'],
    ['avance rápido', 'fastForward'],
    ['adelanta la peli', 'fastForward'],
    ['rebobina', 'rewind'],
    ['rebobina el vídeo', 'rewind'],
    ['retrocede', 'rewind'],
    ['atrasa la serie', 'rewind'],
  ])('«%s» → %s', (frase, command) => {
    expect(parseTvCommand(frase)).toEqual({ action: 'media', command });
  });
  it('se describen en castellano', () => {
    expect(describeTvIntent({ action: 'media', command: 'fastForward' })).toBe('avanzar rápido');
    expect(describeTvIntent({ action: 'media', command: 'rewind' })).toBe('rebobinar');
  });
  it('«adelanta 10 segundos» va al modelo (la tele no salta segundos exactos)', () => {
    expect(parseTvCommand('adelanta 10 segundos')).toBeNull();
  });
  it('«vuelve atrás» sigue siendo la tecla atrás', () => {
    expect(parseTvCommand('vuelve atrás')).toEqual({ action: 'key', name: 'BACK' });
  });
});

describe('tele: «cierra la app» → salir', () => {
  it.each(['cierra la app', 'cierra la aplicación', 'cierra esta app'])('«%s» → EXIT', (frase) => {
    expect(parseTvCommand(frase)).toEqual({ action: 'key', name: 'EXIT' });
  });
  it('«cierra Netflix» va al modelo (no sé si es la app de delante)', () => {
    expect(parseTvCommand('cierra Netflix')).toBeNull();
  });
});
