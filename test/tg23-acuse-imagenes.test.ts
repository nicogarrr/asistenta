/**
 * Varias fotos enviadas «como archivo» (sin comprimir) llegan como un álbum de
 * documentos con mime image/*. El acuse decía «Mirando «IMG_1.jpg»…», como si solo
 * hubiera una, o «Leyendo 3 documentos…» para fotos. Ahora cuenta imágenes.
 */
import { describe, expect, it } from 'vitest';
import { receiptKind, receiptStartText } from '../src/channels/telegram-receipts.js';

const img = (n: number) => ({ fileId: `f${n}`, mimeType: 'image/jpeg', name: `IMG_${n}.jpg` });
const pdf = (n: number) => ({ fileId: `p${n}`, mimeType: 'application/pdf', name: `doc${n}.pdf` });

function ack(first: { mimeType: string; name: string }, rest: unknown[]) {
  const inbound = {
    documentFileId: 'f0',
    documentMimeType: first.mimeType,
    documentName: first.name,
    albumDocuments: rest,
  };
  const kind = receiptKind(inbound);
  return kind ? receiptStartText(kind, inbound) : null;
}

describe('acuse de un álbum de imágenes enviadas como archivo', () => {
  it('varias imágenes: «Mirando las N imágenes…»', () => {
    expect(ack(img(0), [img(1), img(2)])).toBe('🖼️ Mirando las 3 imágenes…');
  });

  it('una imagen y documentos: cuenta documentos, no una sola imagen', () => {
    expect(ack(img(0), [pdf(1)])).toBe('📄 Leyendo 2 documentos…');
  });

  it('solo documentos y una imagen suelta, como antes', () => {
    expect(ack(pdf(0), [pdf(1), pdf(2)])).toBe('📄 Leyendo 3 documentos…');
    expect(ack(img(0), [])).toBe('🖼️ Mirando «IMG_0.jpg»…');
  });
});
