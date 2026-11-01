import { describe, expect, it } from 'vitest';
import { parseTvCommand } from '../src/tv/natural.js';

// «abre youtube ya» buscaba una app llamada «youtube ya» (no existe). El nombre
// de la app se lee sin lo que va detrás: ya, ahora, gracias, en la tele, un rato…
describe('abrir una app con algo detrás del nombre', () => {
  it.each([
    ['abre youtube ya', 'youtube'],
    ['abre netflix ahora mismo', 'netflix'],
    ['abre netflix un rato', 'netflix'],
    ['abre netflix en la tele un rato', 'netflix'],
    ['abre netflix en la tele ya', 'netflix'],
    ['abre youtube, gracias', 'youtube'],
    ['abre netflix otra vez', 'netflix'],
    ['abre netflix, que quiero ver una peli', 'netflix'],
    ['abre la app de netflix', 'netflix'],
    ['abre la app de netflix en la tele', 'netflix'],
    ['vamos a la app de youtube', 'youtube'],
    ['pon youtube ya', 'youtube'],
  ])('«%s» abre %s', (text, appId) => {
    expect(parseTvCommand(text)).toEqual({ action: 'launch', appId });
  });

  it('los nombres de siempre no cambian', () => {
    expect(parseTvCommand('abre prime video')).toEqual({ action: 'launch', appId: 'prime video' });
    expect(parseTvCommand('abre disney+')).toEqual({ action: 'launch', appId: 'disney plus' });
    expect(parseTvCommand('abre el youtube')).toEqual({ action: 'launch', appId: 'youtube' });
    expect(parseTvCommand('abre netflix y pon la peli')).toBeNull();
  });
});
