import { describe, expect, it } from 'vitest';
import { canonicalKey, displayUrl } from '../src/bandeja/captura.js';
import { linkLines } from '../src/bandeja/formato.js';
import type { BandejaItem } from '../src/bandeja/store.js';

describe('bandeja: enlaces limpios al enseñarlos', () => {
  it('quita el rastreo de los «compartir» (si, is, utm_*, y en X s/t/a)', () => {
    expect(displayUrl('https://youtu.be/7Z6x-Ov1smU?is=DZ22iynbQYl-rLb4')).toBe(
      'https://youtu.be/7Z6x-Ov1smU',
    );
    expect(
      displayUrl(
        'https://open.spotify.com/episode/2sDBCcGpgbJ0baMzHH8u37?si=jD2Y2PE6TGeTlLuDRVj6_Q&utm_source=whatsapp',
      ),
    ).toBe('https://open.spotify.com/episode/2sDBCcGpgbJ0baMzHH8u37');
    expect(
      displayUrl('https://x.com/redrum_2001/status/2118435499480072225?a=1sZxxfO5NKjC_1XesgY&s=48'),
    ).toBe('https://x.com/redrum_2001/status/2118435499480072225');
    expect(displayUrl('https://diario.example/a?utm_source=tw&utm_medium=social&id=7')).toBe(
      'https://diario.example/a?id=7',
    );
  });

  it('deja lo que importa: el minuto del vídeo, la búsqueda de una web, el vídeo de watch?v=', () => {
    expect(displayUrl('https://www.youtube.com/watch?v=OKV4yyLOV2c&t=120&si=abc')).toBe(
      'https://www.youtube.com/watch?v=OKV4yyLOV2c&t=120',
    );
    expect(displayUrl('https://blog.example/?s=austria&a=2')).toBe(
      'https://blog.example/?s=austria&a=2',
    );
    expect(displayUrl('https://a.example/x')).toBe('https://a.example/x');
    expect(displayUrl('no es un enlace')).toBe('no es un enlace');
  });

  it('la ficha y el resumen enseñan el limpio; la clave de repetidos no cambia', () => {
    const url = 'https://youtu.be/vP2QPLGnjGo?is=i5Dw2Q5X8uDsi1wn';
    const item = {
      url,
      kind: 'youtube',
      extra: {},
      fileId: null,
      title: 't',
    } as unknown as BandejaItem;
    expect(linkLines(item)).toEqual(['🔗 https://youtu.be/vP2QPLGnjGo']);
    expect(canonicalKey(url)).toBe(canonicalKey('https://youtu.be/vP2QPLGnjGo'));
  });
});
