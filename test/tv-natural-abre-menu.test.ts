import { describe, expect, it } from 'vitest';
import { parseTvCommand } from '../src/tv/natural.js';

// «abre el menú» lanzaba una app llamada «menu», y «abre los ajustes» buscaba «los ajustes».
describe('«abre el menú» / «abre los ajustes»', () => {
  it.each(['abre el menú', 'abre el menu de netflix'])('«%s» no inventa una app', (text) => {
    expect(parseTvCommand(text)).toBeNull();
  });

  it.each([
    ['abre los ajustes', 'ajustes'],
    ['abre netflix', 'netflix'],
    ['abre menudo show', 'menudo show'],
  ])('«%s» abre %s', (text, appId) => {
    expect(parseTvCommand(text)).toEqual({ action: 'launch', appId });
  });
});
