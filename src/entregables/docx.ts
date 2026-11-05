import { leerNumero, numeroES, type Tabla, textoCelda } from './datos.js';
import { xml, zip } from './xlsx.js';

/**
 * «Pásamelo en Word»: un .docx de verdad (Word, LibreOffice, Google Docs o el visor del
 * móvil), sin dependencias: título, el texto (con «# Encabezados», «- viñetas» y
 * «**negrita**» como los escribe el modelo) y, si hay, la tabla con cabecera en negrita,
 * importes a la derecha y fila «Total». Gratis, sin red y en Windows igual.
 */

export interface DocxInput extends Partial<Tabla> {
  titulo: string;
  texto?: string;
  totales?: boolean;
}

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const CAB = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Un «run» de texto; `**negrita**` dentro de la línea se respeta. */
function runs(s: string, bold = false): string {
  const out: string[] = [];
  const parts = s.split(/(\*\*[^*]+\*\*)/g).filter((p) => p !== '');
  for (const p of parts) {
    const b = bold || (p.startsWith('**') && p.endsWith('**') && p.length > 4);
    const t = b && !bold ? p.slice(2, -2) : p;
    out.push(
      `<w:r>${b ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${xml(t)}</w:t></w:r>`,
    );
  }
  return out.join('');
}

const parrafo = (s: string, estilo?: string, align?: 'right'): string =>
  `<w:p>${estilo || align ? `<w:pPr>${estilo ? `<w:pStyle w:val="${estilo}"/>` : ''}${align ? `<w:jc w:val="${align}"/>` : ''}</w:pPr>` : ''}${runs(s)}</w:p>`;

/** El texto del modelo, línea a línea: encabezados, viñetas y párrafos. */
export function cuerpoDocx(texto: string): string {
  const out: string[] = [];
  for (const raw of texto.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const h = /^(#{1,3})\s+(.+)$/.exec(line);
    if (h) {
      out.push(parrafo((h[2] ?? '').replace(/\s*#+$/, ''), `Heading${(h[1] ?? '#').length}`));
      continue;
    }
    const li = /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/.exec(line);
    if (li) {
      out.push(parrafo(`• ${li[1] ?? ''}`, 'ListParagraph'));
      continue;
    }
    out.push(parrafo(line));
  }
  return out.join('');
}

function tablaDocx(t: Tabla, totales?: boolean): string {
  const n = Math.max(t.columnas.length, ...t.filas.map((f) => f.length));
  const esNum = Array.from({ length: n }, (_, c) => {
    const llenas = t.filas.filter((f) => f[c] !== null && f[c] !== undefined && f[c] !== '');
    return (
      llenas.length > 0 &&
      llenas.filter((f) => leerNumero(f[c] ?? null) !== null).length / llenas.length >= 0.8
    );
  });
  const celda = (s: string, c: number, bold: boolean): string =>
    `<w:tc><w:p>${esNum[c] ? '<w:pPr><w:jc w:val="right"/></w:pPr>' : ''}${runs(s, bold)}</w:p></w:tc>`;
  const fila = (vals: string[], bold: boolean, cabecera = false): string =>
    `<w:tr>${cabecera ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${vals.map((v, c) => celda(v, c, bold)).join('')}</w:tr>`;
  const rows = [
    fila(
      Array.from({ length: n }, (_, c) => t.columnas[c] ?? ''),
      true,
      true,
    ),
  ];
  for (const f of t.filas) {
    rows.push(
      fila(
        Array.from({ length: n }, (_, c) => {
          const x = esNum[c] ? leerNumero(f[c] ?? null) : null;
          return x !== null ? numeroES(x) : textoCelda(f[c]);
        }),
        false,
      ),
    );
  }
  if (totales && t.filas.length > 0 && esNum.some(Boolean)) {
    const tot = Array.from({ length: n }, (_, c) =>
      esNum[c]
        ? numeroES(
            Math.round(t.filas.reduce((a, f) => a + (leerNumero(f[c] ?? null) ?? 0), 0) * 100) /
              100,
          )
        : '',
    );
    const primera = esNum.indexOf(false);
    if (primera >= 0) tot[primera] = 'Total';
    rows.push(fila(tot, true));
  }
  const borde = (lado: string): string =>
    `<w:${lado} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`;
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(borde).join('')}</w:tblBorders></w:tblPr><w:tblGrid>${Array.from({ length: n }, () => '<w:gridCol/>').join('')}</w:tblGrid>${rows.join('')}</w:tbl>`;
}

const ESTILOS = `${CAB}<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:lang w:val="es-ES"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360"/></w:pPr></w:style></w:styles>`;

export function crearDocx(input: DocxInput): Buffer {
  const partes = [parrafo(input.titulo, 'Title')];
  if (input.texto?.trim()) partes.push(cuerpoDocx(input.texto));
  if (input.columnas && input.columnas.length > 0) {
    partes.push(tablaDocx({ columnas: input.columnas, filas: input.filas ?? [] }, input.totales));
    partes.push('<w:p/>');
  }
  // A4 con márgenes de 2 cm.
  const body = `${partes.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`;
  const doc = `${CAB}<w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`;
  const tipos = `${CAB}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;
  const rels = `${CAB}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const docRels = `${CAB}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const b = (s: string): Buffer => Buffer.from(s, 'utf8');
  return zip([
    { nombre: '[Content_Types].xml', datos: b(tipos) },
    { nombre: '_rels/.rels', datos: b(rels) },
    { nombre: 'word/document.xml', datos: b(doc) },
    { nombre: 'word/_rels/document.xml.rels', datos: b(docRels) },
    { nombre: 'word/styles.xml', datos: b(ESTILOS) },
  ]);
}
