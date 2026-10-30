import { describe, expect, it } from 'vitest';
import { audioFilename, filenameFrom } from '../src/media/download.js';

const u = (p: string) => new URL(`https://ejemplo.es${p}`);

describe('nombre de fichero de las descargas', () => {
  it('filename* (RFC 5987) manda sobre filename y se decodifica', () => {
    expect(
      filenameFrom(`attachment; filename="x.pdf"; filename*=UTF-8''Factura%20%C3%B1.pdf`, u('/a')),
    ).toBe('Factura ñ.pdf');
  });

  it('filename* con idioma o con otro charset no deja la cabecera en el nombre', () => {
    expect(filenameFrom(`attachment; filename*=UTF-8'es'Recibo.pdf`, u('/a'))).toBe('Recibo.pdf');
    expect(filenameFrom(`attachment; filename*=iso-8859-1''Nomina.pdf`, u('/a'))).toBe(
      'Nomina.pdf',
    );
  });

  it('filename con punto y coma dentro de las comillas', () => {
    expect(filenameFrom('attachment; filename="a;b.pdf"', u('/a'))).toBe('a;b.pdf');
  });

  it('quita marcas de dirección que disfrazan la extensión', () => {
    const name = filenameFrom('attachment; filename="factura\u202Efdp.exe"', u('/a'));
    expect(name).toBe('facturafdp.exe.pdf');
    expect(audioFilename('canción\u202E3pm.exe')).toBe('canción3pm.exe.mp3');
  });

  it('rutas y puntos iniciales no sobreviven', () => {
    expect(filenameFrom('attachment; filename="../../etc/passwd"', u('/a'))).toBe(
      '_.._etc_passwd.pdf',
    );
    expect(filenameFrom('attachment; filename=".."', u('/a'))).toBe('documento.pdf');
    expect(filenameFrom('attachment; filename=".bashrc"', u('/a'))).toBe('bashrc.pdf');
    expect(filenameFrom(null, u('/docs/%2E%2E'))).toBe('documento.pdf');
  });

  it('nombres larguísimos se acortan', () => {
    const name = filenameFrom(null, u(`/${'a'.repeat(5000)}.pdf`));
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name.endsWith('.pdf')).toBe(true);
  });

  it('sigue igual en lo normal', () => {
    expect(filenameFrom(null, u('/docs/Informe%20anual.pdf'))).toBe('Informe anual.pdf');
    expect(filenameFrom(null, u('/'))).toBe('documento.pdf');
    expect(audioFilename('Mi canción: remix')).toBe('Mi canción_ remix.mp3');
    expect(audioFilename('')).toBe('audio.mp3');
  });
});
