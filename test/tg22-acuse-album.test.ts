/**
 * El acuse de un álbum decía «🖼️ Mirando la foto…» aunque llegaran cuatro, y «📄 Leyendo
 * «a.pdf»…» con tres documentos: parecía que el resto se ignoraba. Ahora cuenta todos.
 */
import { describe, expect, it } from 'vitest';
import { receiptKind, receiptStartText } from '../src/channels/telegram-receipts.js';

describe('acuse de un álbum', () => {
  it('cuenta todas las fotos del álbum', () => {
    const inbound = { photoFileId: 'a', albumPhotoFileIds: ['b', 'c', 'd'] };
    expect(receiptStartText(receiptKind(inbound) ?? 'photo', inbound)).toBe(
      '🖼️ Mirando las 4 fotos…',
    );
  });

  it('cuenta todos los documentos del álbum', () => {
    const inbound = {
      documentFileId: 'a',
      documentName: 'a.pdf',
      documentMimeType: 'application/pdf',
      albumDocuments: [{ fileId: 'b' }, { fileId: 'c' }],
    };
    expect(receiptStartText(receiptKind(inbound) ?? 'document', inbound)).toBe(
      '📄 Leyendo 3 documentos…',
    );
  });

  it('una foto o un documento sueltos, como siempre', () => {
    expect(receiptStartText('photo', { photoFileId: 'a' })).toBe('🖼️ Mirando la foto…');
    expect(receiptStartText('document', { documentFileId: 'a', documentName: 'a.pdf' })).toBe(
      '📄 Leyendo «a.pdf»…',
    );
  });
});
