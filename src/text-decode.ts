/**
 * El texto de un fichero tal como lo deja Windows. Antes se leía siempre como UTF-8: un CSV
 * exportado de Excel o un .txt del Bloc de notas antiguo (ANSI, Windows-1252) llegaba con
 * «Facturaci�n», y lo que deja `comando > fichero.txt` en PowerShell 5 (UTF-16 con BOM)
 * llegaba como letras sueltas separadas por NUL. Devuelve el texto y la codificación leída.
 */
export function decodeTextFile(buf: Buffer): { text: string; encoding: string } {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'UTF-16' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'UTF-16' };
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'UTF-8' };
  }
  // UTF-16 sin BOM: texto latino con un NUL detrás de casi cada letra.
  if (buf.length >= 4 && buf.length % 2 === 0) {
    const n = Math.min(buf.length, 4096);
    let oddNul = 0;
    let evenNul = 0;
    for (let i = 0; i < n; i++) if (buf[i] === 0) i % 2 ? oddNul++ : evenNul++;
    if (oddNul > (n / 2) * 0.6 && evenNul < (n / 2) * 0.05) {
      return { text: new TextDecoder('utf-16le').decode(buf), encoding: 'UTF-16' };
    }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'UTF-8' };
  } catch {
    // No es UTF-8 válido: en un Windows en español es casi siempre ANSI (Windows-1252).
    try {
      return { text: new TextDecoder('windows-1252').decode(buf), encoding: 'Windows-1252' };
    } catch {
      return { text: buf.toString('latin1'), encoding: 'Windows-1252' };
    }
  }
}
