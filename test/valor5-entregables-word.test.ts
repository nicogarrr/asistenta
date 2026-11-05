/**
 * «Pásamelo en Word» / «hazme un Word con el resumen»: el tool entregable ya hacía gráfica,
 * Excel y PDF (#2085); faltaba Word, que es lo que se suele pedir para un texto. Ahora
 * formato=word manda un .docx de verdad (título, encabezados, viñetas, negrita y tabla con
 * Total). Un PDF o un Word pueden ser solo texto, sin tabla.
 */
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crearDocx, cuerpoDocx } from '../src/entregables/docx.js';
import { extractOfficeText } from '../src/memory/office.js';
import { createEntregableTool } from '../src/tools/entregable.js';

const textOf = (r: { content: { type: string; text?: string }[] }): string =>
  r.content.map((c) => c.text ?? '').join('');

function unzip(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let off = 0;
  while (buf.readUInt32LE(off) === 0x04034b50) {
    const comp = buf.readUInt32LE(off + 18);
    const nlen = buf.readUInt16LE(off + 26);
    const xlen = buf.readUInt16LE(off + 28);
    const name = buf.subarray(off + 30, off + 30 + nlen).toString('utf8');
    out.set(
      name,
      inflateRawSync(buf.subarray(off + 30 + nlen + xlen, off + 30 + nlen + xlen + comp)).toString(
        'utf8',
      ),
    );
    off += 30 + nlen + xlen + comp;
  }
  return out;
}

describe('Word .docx', () => {
  it('título, encabezados, viñetas, negrita y tabla con Total; lo lee el lector del proyecto', () => {
    const bytes = crearDocx({
      titulo: 'Gastos de octubre',
      texto:
        '# Resumen\nEste mes gasté **más** en restaurantes.\n- Súper: 312,45 €\n- Luz <barata> & gas',
      columnas: ['Categoría', 'Importe'],
      filas: [
        ['Súper', '312,45 €'],
        ['Restaurantes', 1020],
      ],
      totales: true,
    });
    const files = unzip(bytes);
    expect([...files.keys()]).toContain('word/document.xml');
    const doc = files.get('word/document.xml') ?? '';
    expect(doc).toContain('<w:pStyle w:val="Title"/>');
    expect(doc).toContain('<w:pStyle w:val="Heading1"/>');
    expect(doc).toContain('<w:rPr><w:b/></w:rPr><w:t xml:space="preserve">más</w:t>');
    expect(doc).toContain('Luz &lt;barata&gt; &amp; gas');
    expect(doc).toContain('<w:tblHeader/>');
    const txt = extractOfficeText(bytes, 'docx');
    for (const s of [
      'Gastos de octubre',
      'Resumen',
      '• Súper: 312,45 €',
      'Restaurantes',
      '1.020',
      '1.332,45',
      'Total',
    ])
      expect(txt).toContain(s);
  });

  it('el texto del modelo: encabezados y listas numeradas', () => {
    const x = cuerpoDocx('## Pasos\n1. Uno\n2) Dos\n\nFin');
    expect(x).toContain('Heading2');
    expect((x.match(/ListParagraph/g) ?? []).length).toBe(2);
    expect(x).toContain('>Fin<');
  });
});

describe('tool entregable: Word y documentos solo de texto', () => {
  const sent: { name: string; bytes: Buffer }[] = [];
  const tool = createEntregableTool({
    sendPhoto: async () => true,
    sendDocument: async (bytes, name) => {
      sent.push({ name, bytes });
      return true;
    },
  });

  it('«hazme un Word con el resumen» sin tabla', async () => {
    const r = await tool.execute('1', {
      formato: 'word',
      titulo: 'Resumen de la reunión',
      columnas: [],
      filas: [],
      texto: '- Decidimos X\n- Pendiente Y',
    });
    expect(textOf(r)).toContain('«Resumen de la reunión.docx»');
    expect(extractOfficeText(sent.at(-1)?.bytes as Buffer, 'docx')).toContain('Decidimos X');
  });

  it('un PDF solo de texto también vale; gráfica y Excel sin columnas no', async () => {
    expect(
      textOf(
        await tool.execute('2', {
          formato: 'pdf',
          titulo: 'Nota',
          columnas: [],
          filas: [],
          texto: 'Hola',
        }),
      ),
    ).toContain('«Nota.pdf»');
    expect(
      textOf(
        await tool.execute('3', {
          formato: 'excel',
          titulo: 'x',
          columnas: [],
          filas: [],
          texto: 'Hola',
        }),
      ),
    ).toMatch(/Necesito/);
    expect(
      textOf(await tool.execute('4', { formato: 'grafica', titulo: 'x', columnas: [], filas: [] })),
    ).toMatch(/Necesito/);
  });
});
