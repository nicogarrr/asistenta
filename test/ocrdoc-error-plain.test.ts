import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { type EngineDeps, ocrPdf, ocrPhoto } from '../src/ocrdoc/engine.js';

const JERGA = /undefined|properties|Failed|header|offset|Exception|Error|C:\\|line:|col:/;

describe('PDF a texto: fallos en castellano llano', () => {
  it('un PDF dañado no enseña el error de la librería', async () => {
    const p = ocrPdf(new TextEncoder().encode('no soy un pdf'), 'x.pdf', {} as EngineDeps);
    await expect(p).rejects.toThrow(/No he podido abrir el PDF/);
    await expect(p).rejects.not.toThrow(JERGA);
  });

  it('si falla leer el texto, frase clara sin el error técnico', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    const bytes = await doc.save();
    const deps = {
      digitalPages: async () => {
        throw new Error('InvalidPDFException: Invalid PDF structure in C:\\Users\\Nico\\x.pdf');
      },
    } as unknown as EngineDeps;
    const p = ocrPdf(bytes, 'x.pdf', deps);
    await expect(p).rejects.toThrow(/No he podido leer el texto del PDF/);
    await expect(p).rejects.not.toThrow(JERGA);
  });

  it('una imagen rota no enseña el error de la librería', async () => {
    const head = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
    head.writeUInt32BE(13, 8);
    head.write('IHDR', 12, 'latin1');
    head.writeUInt32BE(10, 16);
    head.writeUInt32BE(10, 20);
    head[24] = 8;
    head[25] = 2;
    const bytes = Buffer.concat([head, Buffer.from('basura sin IDAT')]);
    const deps = { ocr: async () => ({ text: '', lines: [] }) } as unknown as EngineDeps;
    const p = ocrPhoto(bytes, 'image/png', 'f.png', deps);
    await expect(p).rejects.toThrow(/No he podido abrir la imagen: parece dañada/);
    await expect(p).rejects.not.toThrow(JERGA);
  });
});
