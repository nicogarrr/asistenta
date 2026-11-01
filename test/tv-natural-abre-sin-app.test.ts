import { describe, expect, it } from 'vitest';
import { parseTvCommand } from '../src/tv/natural.js';

// «abre ya» buscaba y lanzaba una app llamada «ya». Sin nombre de app no se lanza
// nada: la orden va al modelo, que pregunta cuál.
describe('«abre» sin nombre de app', () => {
  it.each([
    'abre ya',
    'abre ahora mismo',
    'abre eso',
    'abre algo',
    'abre la app',
    'abre una aplicacion',
    'abre esa app',
    'abre la tele',
    'abre la tele ya',
    'abre otra vez',
  ])('«%s» no lanza ninguna app', (text) => {
    expect(parseTvCommand(text)).toBeNull();
  });

  it('con nombre sigue igual', () => {
    expect(parseTvCommand('abre youtube ya')).toEqual({ action: 'launch', appId: 'youtube' });
    expect(parseTvCommand('abre la app de netflix')).toEqual({
      action: 'launch',
      appId: 'netflix',
    });
    expect(parseTvCommand('abre yahoo')).toEqual({ action: 'launch', appId: 'yahoo' });
    expect(parseTvCommand('abre apple tv')).toEqual({ action: 'launch', appId: 'apple tv' });
  });
});
