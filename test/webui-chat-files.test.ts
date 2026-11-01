import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/webui/page.js';

interface Fake {
  tag: string;
  className: string | null;
  textContent: string;
  href?: string;
  attrs: Record<string, string>;
  children: Fake[];
  setAttribute(k: string, v: string): void;
  appendChild(c: Fake): void;
}
function el(tag: string, className: string | null = null, texto = ''): Fake {
  return {
    tag,
    className,
    textContent: texto,
    attrs: {},
    children: [],
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    appendChild(c) {
      this.children.push(c);
    },
  };
}

/** Saca pintarArchivos del script de la página y lo ejecuta con un DOM mínimo (sin navegador). */
function pintarArchivos(): (turno: Fake, datos: unknown) => void {
  const html = renderPage();
  const i = html.indexOf('var ARCHIVO_PROHIBIDO');
  const j = html.indexOf('async function repetirUltimo', i);
  expect(i).toBeGreaterThan(0);
  expect(j).toBeGreaterThan(i);
  const fuente = html.slice(i, j);
  return new Function('nodo', `${fuente}; return pintarArchivos;`)(el) as (
    t: Fake,
    d: unknown,
  ) => void;
}

const pdf = 'data:application/pdf;base64,JVBERi0xLjQK';

describe('panel: archivos de un turno como enlaces de descarga', () => {
  it('cada archivo válido sale como enlace con download y el nombre como texto', () => {
    const turno = el('div');
    pintarArchivos()(turno, {
      text: 'ok',
      files: [
        { name: 'informe.pdf', url: pdf },
        { name: 'nota.ogg', url: 'data:audio/ogg;base64,T2dnUw==' },
      ],
    });
    const caja = turno.children[0];
    expect(caja?.attrs['data-archivos']).toBe('2');
    const [a, b] = caja?.children ?? [];
    expect(a).toMatchObject({ tag: 'a', href: pdf, textContent: '📎 informe.pdf' });
    expect(a?.attrs.download).toBe('informe.pdf');
    expect(b?.attrs.download).toBe('nota.ogg');
  });

  it('descarta HTML, SVG, javascript:, URLs http y nombres vacíos; como mucho 4', () => {
    const turno = el('div');
    const malos = [
      { name: 'x.html', url: 'data:text/html;base64,PGI+' },
      { name: 'x.svg', url: 'data:image/svg+xml;base64,PHN2Zz4=' },
      { name: 'x.js', url: 'javascript:alert(1)' },
      { name: 'x.pdf', url: 'https://ejemplo.com/x.pdf' },
      { name: '  ', url: pdf },
      { name: 'x.pdf', url: 'data:application/pdf,sinbase64' },
    ];
    pintarArchivos()(turno, { files: malos });
    expect(turno.children).toHaveLength(0);
    const muchos = Array.from({ length: 6 }, (_, k) => ({ name: `f${k}.pdf`, url: pdf }));
    pintarArchivos()(turno, { files: muchos });
    expect(turno.children[0]?.children).toHaveLength(4);
  });

  it('el nombre no puede traer rutas; una respuesta sin archivos no añade nada', () => {
    const turno = el('div');
    pintarArchivos()(turno, { files: [{ name: '../../etc/passwd', url: pdf }] });
    expect(turno.children[0]?.children[0]?.attrs.download).toBe('.._.._etc_passwd');
    const vacio = el('div');
    pintarArchivos()(vacio, { text: 'hola' });
    pintarArchivos()(vacio, null);
    expect(vacio.children).toHaveLength(0);
  });

  it('se pinta tras la respuesta del chat y tras «Reintentar»', () => {
    const html = renderPage();
    expect(html.match(/pintarArchivos\(espera, datos\);/g)).toHaveLength(2);
  });
});
