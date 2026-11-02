import { describe, expect, it } from 'vitest';
import { kindLabel } from '../src/tools/docs.js';

// bugs16: la lista y la búsqueda de documentos enseñaban el tipo MIME crudo
// («application/vnd.openxmlformats-officedocument.wordprocessingml.document») y el modelo
// se lo podía leer a Nico. Ahora, el nombre que él reconoce.
describe('documents: el tipo de cada documento, en palabras', () => {
  it('Office, LibreOffice, EPUB y texto', () => {
    expect(
      kindLabel('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    ).toBe('Word');
    expect(kindLabel('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe(
      'Excel',
    );
    expect(
      kindLabel('application/vnd.openxmlformats-officedocument.presentationml.presentation'),
    ).toBe('PowerPoint');
    expect(kindLabel('application/vnd.oasis.opendocument.text')).toBe('documento de LibreOffice');
    expect(kindLabel('application/vnd.oasis.opendocument.spreadsheet')).toBe(
      'hoja de cálculo de LibreOffice',
    );
    expect(kindLabel('application/vnd.oasis.opendocument.presentation')).toBe(
      'presentación de LibreOffice',
    );
    expect(kindLabel('application/epub+zip')).toBe('libro EPUB');
    expect(kindLabel('text/plain')).toBe('texto');
    expect(kindLabel('text/markdown')).toBe('texto');
    expect(kindLabel('text/csv')).toBe('CSV');
  });

  it('lo que ya tenía nombre sigue igual; lo desconocido, tal cual', () => {
    expect(kindLabel('application/pdf')).toBe('PDF');
    expect(kindLabel('image/ocr')).toBe('foto, texto leído con OCR');
    expect(kindLabel('audio/transcript')).toBe('audio transcrito');
    expect(kindLabel('application/x-raro')).toBe('application/x-raro');
  });
});
