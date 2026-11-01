/**
 * windows-1252 y su familia de etiquetas (ISO-8859-1, latin1, us-ascii, cp1252…),
 * que WHATWG equipara todas a windows-1252.
 *
 * Node 24.11.0 trae roto `TextDecoder('windows-1252')`: los bytes 0x80-0x9F salen
 * como controles C1 en crudo (en Node 22 va bien), así que el «€», las comillas
 * tipográficas, la raya y la «…» llegan rotos de páginas y correos latin1.
 * `win1252NativeOk` lo detecta una vez y, solo si hace falta, `decodeWin1252`
 * decodifica con la tabla WHATWG. Con un Node sano no cambia nada.
 */

/** Etiquetas que WHATWG equipara a windows-1252. */
export const WIN1252_LABELS = new Set([
  'windows-1252',
  'cp1252',
  'x-cp1252',
  'iso-8859-1',
  'iso8859-1',
  'iso_8859-1',
  'iso_8859-1:1987',
  'latin1',
  'l1',
  'csisolatin1',
  'us-ascii',
  'ascii',
  'ansi_x3.4-1968',
  'cp819',
  'ibm819',
  'iso-ir-100',
]);

/** Rango 0x80-0x9F: lo que windows-1252 imprime donde latin1 solo tiene controles C1. */
const WIN1252_HIGH: Record<number, string> = {
  128: '\u20AC',
  130: '\u201A',
  131: '\u0192',
  132: '\u201E',
  133: '\u2026',
  134: '\u2020',
  135: '\u2021',
  136: '\u02C6',
  137: '\u2030',
  138: '\u0160',
  139: '\u2039',
  140: '\u0152',
  142: '\u017D',
  145: '\u2018',
  146: '\u2019',
  147: '\u201C',
  148: '\u201D',
  149: '\u2022',
  150: '\u2013',
  151: '\u2014',
  152: '\u02DC',
  153: '\u2122',
  154: '\u0161',
  155: '\u203A',
  156: '\u0153',
  158: '\u017E',
  159: '\u0178',
};

/** Decodifica bytes windows-1252 sin depender del TextDecoder de la plataforma. */
export function decodeWin1252(bytes: Uint8Array): string {
  const chars: string[] = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    chars[i] = WIN1252_HIGH[b] ?? String.fromCharCode(b);
  }
  return chars.join('');
}

let nativeOk: boolean | undefined;

/** true si el TextDecoder de esta plataforma decodifica windows-1252 bien. */
export function win1252NativeOk(): boolean {
  if (nativeOk === undefined) {
    try {
      nativeOk = new TextDecoder('windows-1252').decode(Uint8Array.of(0x80)) === '\u20AC';
    } catch {
      nativeOk = false;
    }
  }
  return nativeOk;
}
