import { describe, expect, it } from 'vitest';
import { parseTvCommand } from '../src/tv/natural.js';

// «abre la peli» o «abre la serie» intentaban lanzar una app llamada «peli» o
// «serie». Es lo que se ve, no una app: va al modelo.
describe('«abre la peli» no es una app', () => {
  it.each([
    'abre la peli',
    'abre la serie',
    'abre el partido',
    'abre un video',
    'abre la peli ya',
    'abre el capitulo',
  ])('«%s» no lanza ninguna app', (text) => {
    expect(parseTvCommand(text)).toBeNull();
  });

  it('las apps siguen abriéndose', () => {
    expect(parseTvCommand('abre youtube')).toEqual({ action: 'launch', appId: 'youtube' });
    expect(parseTvCommand('abre spotify')).toEqual({ action: 'launch', appId: 'spotify' });
  });
});
