import { describe, expect, it } from 'vitest';
import { extractMainContent, extractText } from '../src/tools/fetch.js';

const JUNK = '<nav><a href="/">Inicio</a><a href="/publi">Publicidad</a></nav>';
const ARTICLE_TEXT =
  'El ayuntamiento aprobó ayer el nuevo plan de movilidad con doscientos kilómetros ' +
  'de carriles bici y una red de buses lanzadera para los barrios del extrarradio. ' +
  'La medida entra en vigor en enero y tendrá revisión semestral.';

function page(article: string): string {
  const paragraphs = Array.from({ length: 6 }, () => `<p>${article}</p>`).join('');
  return `<!doctype html><html><head><title>Noticia</title></head><body>${JUNK}<article><h1>Plan de movilidad</h1>${paragraphs}</article><footer>Aviso de cookies</footer></body></html>`;
}

describe('modo lectura al leer páginas web', () => {
  it('una página de artículo entrega solo el contenido, sin menús ni pie', async () => {
    const main = await extractMainContent(page(ARTICLE_TEXT));
    const text = await extractText(main, 'text');
    expect(text).toContain('El ayuntamiento aprobó');
    expect(text).toContain('Plan de movilidad');
    expect(text).not.toContain('Publicidad');
    expect(text).not.toContain('cookies');
    // Y gasta bastantes menos tokens que la página entera.
    const full = await extractText(page(ARTICLE_TEXT), 'text');
    expect(text.length).toBeLessThan(full.length);
  });

  it('una página sin artículo claro se queda entera (sin pérdida de información)', async () => {
    const short = '<!doctype html><html><body><p>Hola</p></body></html>';
    expect(await extractMainContent(short)).toBe(short);
    const form = '<!doctype html><html><body><form><input name="q"></form></body></html>';
    expect(await extractMainContent(form)).toBe(form);
  });

  it('entrada rota no lanza: devuelve lo recibido', async () => {
    const garbage = 'esto no es html <<<<>>>>';
    expect(await extractMainContent(garbage)).toBe(garbage);
  });
});
