import { deflateRawSync } from 'node:zlib';
import { type Celda, leerNumero, type Tabla, textoCelda } from './datos.js';
import { crc32 } from './png.js';

/**
 * «Pásamelo en Excel»: un .xlsx de verdad (se abre con doble clic en Excel, LibreOffice o
 * el visor del móvil), escrito aquí sin dependencias: un zip con las cinco piezas XML que
 * pide el formato. Cabecera en negrita y fija, filtro en la cabecera, anchos según el
 * contenido, importes como números (con dos decimales si alguno los tiene) y, si se
 * pide, una fila «Total» con fórmulas SUMA que Excel recalcula.
 */

interface Entrada {
  nombre: string;
  datos: Buffer;
}

/** Zip (deflate) con fecha fija: el mismo contenido da los mismos bytes. */
export function zip(entradas: Entrada[]): Buffer {
  const locales: Buffer[] = [];
  const centrales: Buffer[] = [];
  let offset = 0;
  for (const e of entradas) {
    const nombre = Buffer.from(e.nombre, 'utf8');
    const comp = deflateRawSync(e.datos);
    const crc = crc32(e.datos);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(20, 4);
    loc.writeUInt16LE(0x0800, 6); // nombres en UTF-8
    loc.writeUInt16LE(8, 8); // deflate
    loc.writeUInt16LE(0, 10); // hora
    loc.writeUInt16LE(0x21, 12); // 1980-01-01
    loc.writeUInt32LE(crc, 14);
    loc.writeUInt32LE(comp.length, 18);
    loc.writeUInt32LE(e.datos.length, 22);
    loc.writeUInt16LE(nombre.length, 26);
    loc.writeUInt16LE(0, 28);
    locales.push(loc, nombre, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(e.datos.length, 24);
    cen.writeUInt16LE(nombre.length, 28);
    cen.writeUInt32LE(offset, 42);
    centrales.push(cen, nombre);
    offset += 30 + nombre.length + comp.length;
  }
  const dir = Buffer.concat(centrales);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(entradas.length, 8);
  fin.writeUInt16LE(entradas.length, 10);
  fin.writeUInt32LE(dir.length, 12);
  fin.writeUInt32LE(offset, 16);
  return Buffer.concat([...locales, dir, fin]);
}

/** Escapa para XML y quita los caracteres de control que Excel no acepta. */
export function xml(s: string): string {
  let limpio = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 0xfffe || c === 0xffff) continue;
    limpio += ch;
  }
  return limpio
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 0 → A, 25 → Z, 26 → AA. */
export function letraColumna(i: number): string {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Nombre de hoja válido: sin []:*?/\ y hasta 31 caracteres. */
export function nombreHoja(s: string): string {
  const t = s
    .replace(/[[\]:*?/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 31)
    .trim();
  return t || 'Datos';
}

export interface XlsxInput extends Tabla {
  hoja?: string;
  /** Añade una fila «Total» con SUMA en cada columna de números. */
  totales?: boolean;
}

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CABECERA = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const ESTILOS = `${CABECERA}<styleSheet xmlns="${NS}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="4" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/** Estilos: 0 normal, 1 negrita, 2 número con 2 decimales, 3 número con 2 decimales en negrita. */
export function crearXlsx(input: XlsxInput): Buffer {
  const cols = Math.max(input.columnas.length, ...input.filas.map((f) => f.length), 1);
  const numero = (v: Celda | undefined): number | null => leerNumero(v ?? null);
  // Una columna es «de importes» si la mayoría de sus celdas son números.
  const esNum: boolean[] = [];
  const decimales: boolean[] = [];
  for (let c = 0; c < cols; c++) {
    let n = 0;
    let llenas = 0;
    let dec = false;
    for (const f of input.filas) {
      const v = f[c];
      if (v === null || v === undefined || v === '') continue;
      llenas++;
      const x = numero(v);
      if (x !== null) {
        n++;
        if (!Number.isInteger(x)) dec = true;
      }
    }
    esNum.push(llenas > 0 && n / llenas >= 0.8);
    decimales.push(dec);
  }
  const anchos = new Array<number>(cols).fill(8);
  const medir = (c: number, s: string): void => {
    anchos[c] = Math.min(60, Math.max(anchos[c] ?? 8, s.length + 2));
  };
  const filasXml: string[] = [];
  const celdaTexto = (ref: string, s: string, estilo: number): string =>
    `<c r="${ref}" t="inlineStr"${estilo ? ` s="${estilo}"` : ''}><is><t xml:space="preserve">${xml(s)}</t></is></c>`;
  const cab = input.columnas.map((h, c) => {
    medir(c, h);
    return celdaTexto(`${letraColumna(c)}1`, h, 1);
  });
  filasXml.push(`<row r="1">${cab.join('')}</row>`);
  input.filas.forEach((f, i) => {
    const r = i + 2;
    const celdas: string[] = [];
    for (let c = 0; c < cols; c++) {
      const v = f[c];
      if (v === null || v === undefined || v === '') continue;
      const ref = `${letraColumna(c)}${r}`;
      const x = esNum[c] ? numero(v) : null;
      if (x !== null) {
        medir(c, `${x.toFixed(decimales[c] ? 2 : 0)}   `);
        celdas.push(`<c r="${ref}"${decimales[c] ? ' s="2"' : ''}><v>${x}</v></c>`);
      } else {
        const s = textoCelda(v);
        medir(c, s);
        celdas.push(celdaTexto(ref, s, 0));
      }
    }
    filasXml.push(`<row r="${r}">${celdas.join('')}</row>`);
  });
  const ultima = input.filas.length + 1;
  if (input.totales && input.filas.length > 0 && esNum.some(Boolean)) {
    const r = ultima + 1;
    const celdas: string[] = [];
    let rotulo = false;
    for (let c = 0; c < cols; c++) {
      const ref = `${letraColumna(c)}${r}`;
      if (esNum[c]) {
        const suma = input.filas.reduce((a, f) => a + (numero(f[c]) ?? 0), 0);
        const redondo = Math.round(suma * 1e6) / 1e6;
        celdas.push(
          `<c r="${ref}" s="${decimales[c] ? 3 : 1}"><f>SUM(${letraColumna(c)}2:${letraColumna(c)}${ultima})</f><v>${redondo}</v></c>`,
        );
      } else if (!rotulo) {
        celdas.push(celdaTexto(ref, 'Total', 1));
        rotulo = true;
      }
    }
    filasXml.push(`<row r="${r}">${celdas.join('')}</row>`);
  }
  const ultimaCol = letraColumna(cols - 1);
  const colsXml = anchos
    .map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`)
    .join('');
  const hoja = `${CABECERA}<worksheet xmlns="${NS}" xmlns:r="${NS_R}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${colsXml}</cols><sheetData>${filasXml.join('')}</sheetData>${input.filas.length > 0 ? `<autoFilter ref="A1:${ultimaCol}${ultima}"/>` : ''}</worksheet>`;
  const nombre = xml(nombreHoja(input.hoja ?? 'Datos'));
  const libro = `${CABECERA}<workbook xmlns="${NS}" xmlns:r="${NS_R}"><sheets><sheet name="${nombre}" sheetId="1" r:id="rId1"/></sheets>${input.filas.length > 0 ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${nombre.replace(/'/g, "''")}'!$A$1:$${ultimaCol}$${ultima}</definedName></definedNames>` : ''}</workbook>`;
  const tipos = `${CABECERA}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;
  const rels = `${CABECERA}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const libroRels = `${CABECERA}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const b = (s: string): Buffer => Buffer.from(s, 'utf8');
  return zip([
    { nombre: '[Content_Types].xml', datos: b(tipos) },
    { nombre: '_rels/.rels', datos: b(rels) },
    { nombre: 'xl/workbook.xml', datos: b(libro) },
    { nombre: 'xl/_rels/workbook.xml.rels', datos: b(libroRels) },
    { nombre: 'xl/worksheets/sheet1.xml', datos: b(hoja) },
    { nombre: 'xl/styles.xml', datos: b(ESTILOS) },
  ]);
}
