import { describe, expect, it } from 'vitest';
import { describeTvIntent, parseTvCommand } from '../src/tv/natural.js';

// asis-bugs-1: «abre youtube» respondía «Entendido: abrir youtube.», con el alias en
// minúsculas, justo encima de «He abierto YouTube en la tele.».
const said = (text: string) => {
  const intent = parseTvCommand(text);
  if (!intent) throw new Error(`sin orden: ${text}`);
  return describeTvIntent(intent);
};

describe('tele: el nombre de la app se escribe como es', () => {
  it('«abre youtube» → abrir YouTube; Disney+, Prime Video, Netflix igual', () => {
    expect(said('abre youtube')).toBe('abrir YouTube');
    expect(said('abre disney')).toBe('abrir Disney+');
    expect(said('abre netflix')).toBe('abrir Netflix');
    expect(said('pon prime video')).toBe('abrir Prime Video');
  });

  it('una app que no conozco se queda como la dijo', () => {
    expect(describeTvIntent({ action: 'launch', appId: 'rtve play' })).toBe('abrir rtve play');
  });
});
