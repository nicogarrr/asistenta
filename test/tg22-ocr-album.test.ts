/**
 * «/ocr» (o «hazlo buscable») con un álbum: Telegram manda cada foto en su mensaje y
 * desde #1807 llegan juntas en un turno, pero el OCR solo leía la primera y las demás
 * se perdían sin decirlo. Ahora lee todas, una detrás de otra, con el resultado numerado.
 * Descarga y OCR falsos.
 */
import { describe, expect, it } from 'vitest';
import type { Inbound } from '../src/channels/types.js';
import { ocrEachFile, ocrFiles } from '../src/cli.js';

const base = { text: '', messageId: '5', chatId: '1' } as Inbound;

function fakes(missing: string[] = []) {
  const said: string[] = [];
  const sent: string[] = [];
  const ran: string[] = [];
  return {
    said,
    sent,
    ran,
    deps: {
      download: async (id: string) => (missing.includes(id) ? null : Buffer.from(id)),
      run: async (bytes: Buffer, name: string | undefined) => {
        ran.push(`${bytes.toString()}:${name ?? ''}`);
        return {
          message: `Listo ${bytes.toString()}.`,
          files: [{ bytes, filename: `${bytes.toString()}.md` }],
        };
      },
      sendFile: async (f: { filename: string }) => void sent.push(f.filename),
      say: async (t: string) => void said.push(t),
    },
  };
}

describe('OCR de un álbum', () => {
  it('lee todas las fotos del álbum, no solo la primera', () => {
    expect(ocrFiles({ ...base, photoFileId: 'a', albumPhotoFileIds: ['b', 'c'] })).toEqual([
      { fileId: 'a' },
      { fileId: 'b' },
      { fileId: 'c' },
    ]);
  });

  it('y todos los documentos de un álbum, con su nombre', () => {
    expect(
      ocrFiles({
        ...base,
        documentFileId: 'd1',
        documentName: 'uno.pdf',
        albumDocuments: [{ fileId: 'd2', name: 'dos.pdf' }],
      }),
    ).toEqual([
      { fileId: 'd1', name: 'uno.pdf' },
      { fileId: 'd2', name: 'dos.pdf' },
    ]);
  });

  it('sin archivo no hay nada que leer', () => {
    expect(ocrFiles(base)).toEqual([]);
  });

  it('con varios: un aviso, cada resultado numerado y todos los ficheros', async () => {
    const f = fakes();
    await ocrEachFile([{ fileId: 'a' }, { fileId: 'b' }, { fileId: 'c' }], f.deps);
    expect(f.ran).toEqual(['a:', 'b:', 'c:']);
    expect(f.sent).toEqual(['a.md', 'b.md', 'c.md']);
    expect(f.said).toEqual([
      'Recibidos 3, los estoy procesando uno a uno. Si tienen muchas páginas tarda unos minutos.',
      '(1/3) Listo a.',
      '(2/3) Listo b.',
      '(3/3) Listo c.',
    ]);
  });

  it('una foto que no baja no para las demás, y se dice cuántas faltan', async () => {
    const f = fakes(['b']);
    await ocrEachFile([{ fileId: 'a' }, { fileId: 'b' }, { fileId: 'c' }], f.deps);
    expect(f.ran).toEqual(['a:', 'c:']);
    expect(f.said.at(-1)).toContain('1 de 3 no los he podido bajar');
  });

  it('con un solo archivo, los mensajes de siempre', async () => {
    const f = fakes();
    await ocrEachFile([{ fileId: 'a', name: 'x.pdf' }], f.deps);
    expect(f.ran).toEqual(['a:x.pdf']);
    expect(f.said).toEqual([
      'Recibido, lo estoy procesando. Si tiene muchas páginas tarda unos minutos.',
      'Listo a.',
    ]);
    const g = fakes(['a']);
    await ocrEachFile([{ fileId: 'a' }], g.deps);
    expect(g.said).toEqual([
      'No he podido bajar el archivo (Telegram solo me deja hasta 20 MB). Si es más grande, pártelo.',
    ]);
  });
});
