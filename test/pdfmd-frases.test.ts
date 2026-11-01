import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isPdfAttachment, pdfToTextIntent } from '../src/pdfmd/chat-intent.js';

const pdf = (text: string) => ({
  text,
  documentFileId: 'f1',
  documentMimeType: 'application/pdf',
  documentName: 'factura.pdf',
});

describe('«pásame este PDF a texto» con un PDF adjunto', () => {
  it.each([
    'pásame este PDF a texto',
    'Pásamelo a texto, porfa',
    '¿puedes pasarme este pdf a texto?',
    'conviértelo a markdown',
    'pasa esto a md',
    'sácame el texto',
    'extrae el texto del PDF',
    'dame el texto de este pdf',
    'transcríbemelo',
    'hazle OCR',
    'pásale el ocr',
  ])('«%s» arranca el OCR en Markdown', (text) => {
    expect(pdfToTextIntent(pdf(text))).toBe('md');
  });

  it.each([
    '',
    'resume este PDF',
    '¿qué dice la página 3?',
    'guárdalo',
    'no lo pases a texto, solo guárdalo',
    '/ocr md',
    'pásame a texto la tabla de la página 3 y dime cuánto suman las facturas de octubre',
    'mira el contexto de este contrato',
  ])('«%s» sigue la conversación normal', (text) => {
    expect(pdfToTextIntent(pdf(text))).toBeNull();
  });

  it('sin PDF no hace nada', () => {
    expect(pdfToTextIntent({ text: 'pásame esto a texto' })).toBeNull();
    expect(
      pdfToTextIntent({
        text: 'pásame esto a texto',
        documentFileId: 'f1',
        documentMimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        documentName: 'carta.docx',
      }),
    ).toBeNull();
  });

  it('reconoce el PDF por el tipo o por el nombre', () => {
    expect(isPdfAttachment({ documentFileId: 'f', documentMimeType: 'APPLICATION/PDF' })).toBe(
      true,
    );
    expect(isPdfAttachment({ documentFileId: 'f', documentName: 'Escaneo.PDF' })).toBe(true);
    expect(isPdfAttachment({ documentName: 'a.pdf' })).toBe(false);
  });
});

describe('enganche en el daemon', () => {
  const cli = readFileSync('src/cli.ts', 'utf8');

  it('la frase lleva al mismo trabajo que «/ocr md», solo en el chat del dueño', () => {
    expect(cli).toMatch(
      /isOwnerDm\(inbound, vigilanteOwnerId\) && pdfToTextIntent\(inbound\)\) \{\s*await cmdOcr\(inbound, 'md'\);\s*return;/,
    );
  });

  it('va antes de abrir el turno del modelo', () => {
    const hook = cli.indexOf('pdfToTextIntent(inbound)');
    const control = cli.indexOf("if (control === 'handled') return;");
    const turn = cli.indexOf('const thread = await resolveThread(inbound);', control);
    expect(hook).toBeGreaterThan(control);
    expect(hook).toBeLessThan(turn);
  });
});
