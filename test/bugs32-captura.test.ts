import { describe, expect, it } from 'vitest';
import { detectCapture, extractUrls } from '../src/bandeja/captura.js';
import { hiddenLinks } from '../src/channels/telegram.js';

// bugs-32 (11 nov 2026): falsos negativos de la regla de captura de la bandeja.

const FWD = '[Mensaje reenviado de Canal Inversión]';

describe('captura: reenvíos de canales', () => {
  it('un post reenviado con foto y pie (el texto del canal) va a la bandeja con su pie como nota', () => {
    const got = detectCapture({
      text: `${FWD}\nAST SpaceMobile anuncia su propio cohete. Hilo completo abajo.`,
      photoFileId: 'P1',
      forwardedFrom: FWD,
    });
    expect(got).toEqual([
      {
        kind: 'imagen',
        fileId: 'P1',
        mimeType: 'image/jpeg',
        note: 'AST SpaceMobile anuncia su propio cohete. Hilo completo abajo.',
      },
    ]);
  });

  it('si el post reenviado trae enlace, se guarda el enlace (la foto es su portada)', () => {
    const got = detectCapture({
      text: `${FWD}\nNuevo análisis: https://example.com/asts-cohete`,
      photoFileId: 'P1',
      forwardedFrom: FWD,
    });
    expect(got?.map((c) => [c.kind, c.url])).toEqual([
      ['enlace', 'https://example.com/asts-cohete'],
    ]);
  });

  it('un PDF reenviado con pie del canal también', () => {
    const got = detectCapture({
      text: `${FWD}\nInforme Q3 completo`,
      documentFileId: 'D1',
      documentMimeType: 'application/pdf',
      documentName: 'q3.pdf',
      forwardedFrom: FWD,
    });
    expect(got?.[0]).toMatchObject({ kind: 'pdf', fileId: 'D1', note: 'Informe Q3 completo' });
  });

  it('el enlace escondido tras «Leer más» de un post reenviado se guarda', () => {
    const got = detectCapture({
      text: `${FWD}\nLa Fed recorta tipos. Leer más`,
      forwardedFrom: FWD,
      linkUrls: ['https://www.expansion.com/mercados/fed.html'],
    });
    expect(got?.map((c) => c.url)).toEqual(['https://www.expansion.com/mercados/fed.html']);
    expect(got?.[0]?.note).toContain('La Fed recorta tipos');
  });

  it('lo tuyo sigue siendo conversación: foto o PDF con TU pie, y tu frase con un enlace escondido', () => {
    expect(detectCapture({ text: '¿esto qué es?', photoFileId: 'P' })).toBeNull();
    expect(
      detectCapture({
        text: '¿qué opinas?',
        documentFileId: 'D',
        documentMimeType: 'application/pdf',
      }),
    ).toBeNull();
    expect(
      detectCapture({ text: 'mira esto y dime', linkUrls: ['https://example.com/x'] }),
    ).toBeNull();
    // Reenvío con tu comentario detrás: el comentario manda.
    expect(
      detectCapture({
        text: `${FWD}\nfoto\n[Fin del mensaje reenviado; lo que sigue lo escribe el dueño]\n¿y esto?`,
        photoFileId: 'P',
        forwardedFrom: FWD,
      }),
    ).toBeNull();
  });

  it('el adaptador de Telegram saca los text_link del texto y del pie', () => {
    expect(
      hiddenLinks({
        text: 'La Fed recorta. Leer más',
        entities: [
          { type: 'bold', offset: 0, length: 6 },
          { type: 'text_link', offset: 16, length: 8, url: 'https://a.com/fed' },
          { type: 'text_link', offset: 0, length: 2, url: 'https://a.com/fed' },
          { type: 'text_link', offset: 0, length: 2, url: 'tg://user?id=1' },
        ],
      }),
    ).toEqual(['https://a.com/fed']);
    expect(
      hiddenLinks({
        caption: 'x',
        caption_entities: [{ type: 'text_link', offset: 0, length: 1, url: 'https://b.com/y' }],
      }),
    ).toEqual(['https://b.com/y']);
    expect(hiddenLinks({ text: 'nada' })).toEqual([]);
  });
});

describe('captura: enlaces con paréntesis', () => {
  it('un paréntesis del propio enlace se queda; el de la frase se va', () => {
    expect(extractUrls('https://es.wikipedia.org/wiki/Ludwig_von_Mises_(economista)')).toEqual([
      'https://es.wikipedia.org/wiki/Ludwig_von_Mises_(economista)',
    ]);
    expect(extractUrls('(lo vi en https://example.com/a)')).toEqual(['https://example.com/a']);
    expect(extractUrls('mira https://example.com/a_(b)).')).toEqual(['https://example.com/a_(b)']);
    expect(extractUrls('https://example.com/a, y ya')).toEqual(['https://example.com/a']);
  });

  it('el enlace de Wikipedia a secas va a la bandeja entero', () => {
    expect(
      detectCapture({ text: 'https://en.wikipedia.org/wiki/Mercury_(planet)' })?.[0]?.url,
    ).toBe('https://en.wikipedia.org/wiki/Mercury_(planet)');
  });
});
