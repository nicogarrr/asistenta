/**
 * Texto de un .env tal como lo guarda Windows: el Bloc de notas y PowerShell 5
 * guardan a menudo con BOM (UTF-8) o en UTF-16. Módulo sin efectos al
 * importarlo (envfile.ts carga el .env al evaluarse), para que quien escribe
 * el .env (p. ej. el setup de libros) lo lea igual que el arranque.
 */
/** Sin BOM y, si viene en UTF-16, decodificado. */
export function envFileText(buf: Buffer): string {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
    return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const le = Buffer.from(buf.subarray(2));
    le.swap16();
    return le.toString('utf16le');
  }
  return buf.toString('utf8');
}
