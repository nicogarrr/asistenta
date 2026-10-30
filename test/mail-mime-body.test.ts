import { describe, expect, it } from 'vitest';
import { toMessage } from '../src/mail/client.js';
import { extractBodyText } from '../src/mail/mime.js';

const crlf = (s: string) => s.replace(/\n/g, '\r\n');

describe('cuerpo de correo decodificado (MIME)', () => {
  it('quoted-printable UTF-8 llega como texto legible', () => {
    const source = crlf(
      'Subject: hola\nContent-Type: text/plain; charset="utf-8"\nContent-Transfer-Encoding: quoted-printable\n\n=C2=BFQu=C3=A9 tal? Tu pedido de 12,50 =E2=82=AC est=C3=A1 =\nlisto.\n',
    );
    const m = toMessage({ uid: 1, source: Buffer.from(source) }, 'INBOX');
    expect(m.text).toBe('¿Qué tal? Tu pedido de 12,50 € está listo.');
  });

  it('multipart/alternative: prefiere text/plain y no muestra fronteras ni base64', () => {
    const html = Buffer.from('<p>Hola <b>Nico</b></p>').toString('base64');
    const plain = Buffer.from('Hola Nico, cita el martes', 'utf8').toString('base64');
    const source = crlf(
      `Subject: x\nMIME-Version: 1.0\nContent-Type: multipart/alternative; boundary="b1"\n\n--b1\nContent-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: base64\n\n${plain}\n--b1\nContent-Type: text/html; charset=utf-8\nContent-Transfer-Encoding: base64\n\n${html}\n--b1--\n`,
    );
    const m = toMessage({ uid: 2, source: Buffer.from(source) }, 'INBOX');
    expect(m.text).toBe('Hola Nico, cita el martes');
    expect(m.text).not.toContain('--b1');
    expect(m.text).not.toContain('Content-Type');
  });

  it('solo HTML en base64 dentro de mixed con adjunto: texto sin etiquetas y sin el adjunto', () => {
    const html = Buffer.from(
      '<div>Factura&nbsp;n&#186; 7 &amp; m&aacute;s</div><style>p{}</style>',
    ).toString('base64');
    const pdf = Buffer.from('%PDF-1.4 binario').toString('base64');
    const source = crlf(
      `Subject: x\nContent-Type: multipart/mixed; boundary=zz\n\n--zz\nContent-Type: text/html; charset=UTF-8\nContent-Transfer-Encoding: base64\n\n${html}\n--zz\nContent-Type: application/pdf\nContent-Disposition: attachment; filename=f.pdf\nContent-Transfer-Encoding: base64\n\n${pdf}\n--zz--\n`,
    );
    const text = extractBodyText(Buffer.from(source)).trim();
    expect(text).toContain('Factura nº 7 & m');
    expect(text).not.toContain('PDF');
    expect(text).not.toContain('<div>');
  });

  it('charset iso-8859-1 en 8bit se decodifica con su charset', () => {
    const head = Buffer.from(
      'Subject: x\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\n',
    );
    const body = Buffer.from([0x41, 0xf1, 0x6f, 0x20, 0x6e, 0x75, 0x65, 0x76, 0x6f]); // "Año nuevo"
    const m = toMessage({ uid: 3, source: Buffer.concat([head, body]) }, 'INBOX');
    expect(m.text).toBe('Año nuevo');
  });

  it('entidades: &amp;lt; no se decodifica dos veces', () => {
    const source = crlf('Subject: x\nContent-Type: text/html\n\n<p>a &amp;lt; b</p>');
    expect(extractBodyText(source).trim()).toBe('a &lt; b');
  });

  it('sigue aceptando fuentes mínimas y truncadas sin lanzar', () => {
    expect(
      toMessage({ uid: 4, source: Buffer.from('Subject: ok\r\n\r\nPedido confirmado') }, 'INBOX')
        .text,
    ).toBe('Pedido confirmado');
    expect(toMessage({ uid: 5, source: Buffer.from('hello') }, 'INBOX').text).toBe('hello');
    const truncated = crlf(
      'Content-Type: multipart/alternative; boundary=q\n\n--q\nContent-Type: text/plain\n\nmitad del texto',
    );
    expect(extractBodyText(truncated).trim()).toBe('mitad del texto');
  });

  it('texto plano declarado conserva direcciones entre <>', () => {
    const source = crlf('Content-Type: text/plain; charset=utf-8\n\nEscribe a <ana@ejemplo.es>');
    expect(extractBodyText(source).trim()).toBe('Escribe a <ana@ejemplo.es>');
  });
});
