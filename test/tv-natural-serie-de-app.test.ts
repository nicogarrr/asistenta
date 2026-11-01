import { describe, expect, it } from 'vitest';
import { parseTvCommand } from '../src/tv/natural.js';

// «abre la serie de netflix» buscaba una app llamada «serie de netflix».
describe('«abre la serie de netflix» abre Netflix', () => {
  it.each([
    ['abre la serie de netflix', 'netflix'],
    ['pon la serie de netflix', 'netflix'],
    ['quiero ver la serie de netflix', 'netflix'],
    ['abre la peli de disney', 'disney'],
    ['abre la peli en prime video', 'prime video'],
    ['abre la serie de netflix que estaba viendo', 'netflix'],
  ])('«%s» abre %s', (text, appId) => {
    expect(parseTvCommand(text)).toEqual({ action: 'launch', appId });
  });

  it.each([
    'abre la serie de la casa de papel',
    'abre el partido de dazn',
    'pon la peli de la tele',
  ])('«%s» no inventa una app: va al modelo', (text) => {
    expect(parseTvCommand(text)).toBeNull();
  });
});
