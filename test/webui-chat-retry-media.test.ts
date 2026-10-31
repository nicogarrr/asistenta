import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/webui/page.js';
import { startWebUi, type WebUiDeps } from '../src/webui/server.js';

const png = 'data:image/png;base64,iVBORw0KGgo=';
const pdf = 'data:application/pdf;base64,JVBERi0xLjQK';
const base: WebUiDeps = {
  token: 'test-only',
  status: () => ({}),
  sessions: () => [],
  memory: () => [],
  auditVerify: () => ({}),
};
const headers = { Authorization: 'Bearer test-only', 'Content-Type': 'application/json' };

describe('panel: «Reintentar» también trae las capturas y archivos del turno repetido', () => {
  it('POST /api/chat/retry devuelve images y files filtrados como /api/chat', async () => {
    const ui = await startWebUi({
      ...base,
      retry: async () => ({
        text: 'otra vez',
        images: [png, 'data:image/svg+xml;base64,PHN2Zz4=', 'https://x.test/a.png'],
        files: [
          { name: 'informe.pdf', url: pdf },
          { name: '../x.pdf', url: pdf },
          { name: 'p.html', url: 'data:text/html;base64,PGI+' },
        ],
      }),
    });
    try {
      const r = await fetch(`${ui.url}/api/chat/retry`, { method: 'POST', headers, body: '{}' });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({
        text: 'otra vez',
        images: [png],
        files: [{ name: 'informe.pdf', url: pdf }],
      });
    } finally {
      await ui.close();
    }
  });

  it('sin capturas ni archivos, la respuesta sigue siendo solo el texto', async () => {
    const ui = await startWebUi({ ...base, retry: async () => ({ text: 'hola' }) });
    try {
      const r = await fetch(`${ui.url}/api/chat/retry`, { method: 'POST', headers, body: '{}' });
      expect(await r.json()).toEqual({ text: 'hola' });
    } finally {
      await ui.close();
    }
  });
});

interface Fake {
  tag: string;
  className: string | null;
  textContent: string;
  src?: string;
  alt?: string;
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
/** pintarArchivos de la página (lo usan el chat y «Reintentar»), con un DOM mínimo. */
function pintar(): (turno: Fake, datos: unknown) => void {
  const html = renderPage();
  const i = html.indexOf('var ARCHIVO_PROHIBIDO');
  const j = html.indexOf('async function repetirUltimo', i);
  expect(i).toBeGreaterThan(0);
  return new Function('nodo', `${html.slice(i, j)}; return pintarArchivos;`)(el) as (
    t: Fake,
    d: unknown,
  ) => void;
}

describe('panel: las capturas de un turno se ven en el chat', () => {
  it('PNG/JPEG data: salen como <img> con texto alternativo; lo demás no', () => {
    const turno = el('div');
    pintar()(turno, {
      text: 'ok',
      images: [
        png,
        'data:image/jpeg;base64,/9j/4AAQ',
        'data:image/svg+xml;base64,PHN2Zz4=',
        'javascript:alert(1)',
        7,
      ],
    });
    const caja = turno.children.find((c) => c.className === 'capturas');
    expect(caja?.attrs['data-capturas']).toBe('2');
    expect(caja?.children.map((c) => [c.tag, c.src])).toEqual([
      ['img', png],
      ['img', 'data:image/jpeg;base64,/9j/4AAQ'],
    ]);
    expect(caja?.children[0]?.alt).toBe('Captura 1');
  });

  it('como mucho 4 capturas, y ninguna caja si no hay', () => {
    const turno = el('div');
    pintar()(turno, { text: 'ok', images: [png, png, png, png, png, png] });
    expect(turno.children[0]?.children).toHaveLength(4);
    const vacio = el('div');
    pintar()(vacio, { text: 'ok' });
    expect(vacio.children).toHaveLength(0);
  });

  it('«Reintentar» pinta capturas y archivos del turno repetido', () => {
    const html = renderPage();
    const k = html.indexOf('async function repetirUltimo');
    const fin = html.indexOf('async function cargarObjetivos', k);
    expect(html.slice(k, fin)).toContain('pintarArchivos(espera, datos)');
  });
});
