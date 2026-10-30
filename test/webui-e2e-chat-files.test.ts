import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/webui/page.js';
import { startWebUi, type WebUiDeps } from '../src/webui/server.js';

// e2e simulado del panel (sin navegador): /api/chat con archivos → enlaces de descarga.
const TOKEN = 'token-e2e-archivos';
const pdf = 'data:application/pdf;base64,JVBERi0xLjQK';
const ogg = 'data:audio/ogg;base64,T2dnUw==';
const largo = `${'informe-trimestral-de-gastos-de-la-casa-'.repeat(2)}2026.pdf`;

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
function pintarDesde(html: string): (t: Fake, d: unknown) => void {
  const i = html.indexOf('var ARCHIVO_PROHIBIDO');
  const j = html.indexOf('async function repetirUltimo', i);
  expect(i).toBeGreaterThan(0);
  return new Function('nodo', `${html.slice(i, j)}; return pintarArchivos;`)(el) as (
    t: Fake,
    d: unknown,
  ) => void;
}
const base: WebUiDeps = {
  token: TOKEN,
  status: () => ({}),
  sessions: () => [],
  memory: () => [],
  auditVerify: () => ({}),
};

describe('e2e panel (simulado): los archivos de un turno salen como enlaces de descarga', () => {
  it('página servida + /api/chat con archivos → un enlace «download» por archivo válido', async () => {
    const ui = await startWebUi({
      ...base,
      chat: async () => ({
        text: 'Aquí tienes',
        files: [
          { name: largo, url: pdf },
          { name: 'nota.ogg', url: ogg },
          { name: 'x.html', url: 'data:text/html;base64,PGI+' },
        ],
      }),
    });
    try {
      const pagina = await fetch(`${ui.url}/`);
      expect(pagina.status).toBe(200);
      const html = await pagina.text();
      const r = await fetch(`${ui.url}/api/chat`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hazme el informe' }),
      });
      expect(r.status).toBe(200);
      const datos = await r.json();
      const turno = el('div', 'turno asistente');
      pintarDesde(html)(turno, datos);
      const caja = turno.children.find((c) => c.className === 'archivos');
      expect(caja?.attrs['data-archivos']).toBe('2');
      expect(caja?.children.map((a) => [a.tag, a.className, a.attrs.download, a.href])).toEqual([
        ['a', 'archivo', largo, pdf],
        ['a', 'archivo', 'nota.ogg', ogg],
      ]);
    } finally {
      await ui.close();
    }
  });

  it('a 390 px un nombre largo no se sale del chat: los enlaces parten la línea', () => {
    const html = renderPage();
    const regla = (sel: string) =>
      html.match(new RegExp(`\\n\\s*\\${sel} \\{([^}]*)\\}`))?.[1] ?? '';
    expect(regla('.archivo')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(regla('.archivo')).toMatch(/max-width:\s*100%/);
    expect(regla('.archivos')).toMatch(/max-width:\s*100%/);
  });

  it('cada enlace es un objetivo táctil cómodo (≥ 10 px de relleno vertical)', () => {
    const html = renderPage();
    const r = html.match(/\n\s*\.archivo \{([^}]*)\}/)?.[1] ?? '';
    const pad = Number(r.match(/padding:\s*(\d+)px/)?.[1] ?? 0);
    expect(pad).toBeGreaterThanOrEqual(10);
  });
});
