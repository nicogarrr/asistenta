/**
 * «Guarda esta web en mis documentos» (hueco #12 del informe): antes la memoria de
 * documentos solo guardaba lo que se reenviaba por Telegram; una web había que copiarla a
 * mano. Ahora `documents` con action=save_url la descarga (mismo filtro que el tool fetch),
 * guarda su texto en la estantería de este chat y se puede buscar después. Guardar otra vez
 * la misma web la actualiza (no la duplica). Red simulada.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DocMemory } from '../src/memory/docs.js';
import { createDocsTool, normalizeSavedUrl, savedPageTitle } from '../src/tools/docs.js';
import type { FetchedPage } from '../src/tools/fetch.js';

const opened: Array<{ m: DocMemory; dir: string }> = [];
afterEach(() => {
  for (const o of opened.splice(0)) {
    o.m.close();
    rmSync(o.dir, { recursive: true, force: true });
  }
});
const mem = (): DocMemory => {
  const dir = mkdtempSync(join(tmpdir(), 'v5-web-'));
  const m = new DocMemory({ dbPath: join(dir, 'd.sqlite'), directory: join(dir, 'txt') });
  opened.push({ m, dir });
  return m;
};
const textOf = (r: unknown): string =>
  (r as { content: Array<{ text?: string }> }).content.map((c) => c.text ?? '').join('\n');
const A = 'telegram:main:111#main';

const page = (url: string, text: string, truncated = false): FetchedPage => ({
  url,
  status: 200,
  contentType: 'text/html',
  chars: text.length,
  truncated,
  text,
});

describe('documents: guardar una web', () => {
  it('«guarda esta web en mis documentos» y luego se encuentra buscando', async () => {
    const m = mem();
    const urls: string[] = [];
    const tool = createDocsTool(m, () => A, {
      fetchPage: async (url) => {
        urls.push(url);
        return page(
          url,
          '# Receta de fabada asturiana\n\nPon las fabes en remojo la noche anterior con agua fría.',
        );
      },
    });
    const r = textOf(
      await tool.execute(
        '1',
        { action: 'save_url', url: 'https://www.recetas.es/fabada/#ingredientes' },
        undefined as never,
        undefined as never,
      ),
    );
    expect(urls).toEqual(['https://www.recetas.es/fabada']);
    expect(r).toContain('Guardada en tus documentos: "Receta de fabada asturiana (recetas.es)"');
    const found = textOf(
      await tool.execute(
        '2',
        { action: 'search', query: 'fabes remojo' },
        undefined as never,
        undefined as never,
      ),
    );
    expect(found).toContain('Receta de fabada asturiana');
    expect(found).toContain('remojo');
  });

  it('guardar otra vez la misma web la actualiza, no la duplica', async () => {
    const m = mem();
    let body = '# Horario\n\nAbre de 9 a 14.';
    const tool = createDocsTool(m, () => A, { fetchPage: async (url) => page(url, body) });
    await tool.execute(
      '1',
      { action: 'save_url', url: 'https://ayto.gijon.es/horario' },
      undefined as never,
      undefined as never,
    );
    body = '# Horario\n\nAbre de 10 a 15 y por la tarde de 17 a 19.';
    await tool.execute(
      '2',
      { action: 'save_url', url: 'https://ayto.gijon.es/horario/' },
      undefined as never,
      undefined as never,
    );
    const list = textOf(
      await tool.execute('3', { action: 'list' }, undefined as never, undefined as never),
    );
    expect(list.split('\n').filter((l) => l.includes('Horario'))).toHaveLength(1);
    expect(
      textOf(
        await tool.execute(
          '4',
          { action: 'search', query: 'tarde' },
          undefined as never,
          undefined as never,
        ),
      ),
    ).toContain('Horario');
  });

  it('una web que no se abre o sin texto no guarda nada y lo dice', async () => {
    const m = mem();
    const fail = createDocsTool(m, () => A, {
      fetchPage: async () => {
        throw new Error('refusing to fetch http://192.168.1.1: not a public http(s) URL');
      },
    });
    expect(
      textOf(
        await fail.execute(
          '1',
          { action: 'save_url', url: 'http://192.168.1.1' },
          undefined as never,
          undefined as never,
        ),
      ),
    ).toMatch(/No he podido abrir esa web/);
    const empty = createDocsTool(m, () => A, { fetchPage: async (url) => page(url, '   ') });
    expect(
      textOf(
        await empty.execute(
          '2',
          { action: 'save_url', url: 'https://x.es/foto' },
          undefined as never,
          undefined as never,
        ),
      ),
    ).toMatch(/no he guardado nada/);
    expect(m.listIn([A])).toHaveLength(0);
    await expect(
      fail.execute(
        '3',
        { action: 'save_url', url: 'file:///C:/secreto.txt' },
        undefined as never,
        undefined as never,
      ),
    ).rejects.toThrow(/url http\(s\)/);
  });

  it('una web muy larga se guarda en parte y lo avisa', async () => {
    const m = mem();
    const tool = createDocsTool(m, () => A, {
      fetchPage: async (url) =>
        page(url, '# Ley larga\n\nArtículo primero.\n\n[truncated at 400000 chars]', true),
    });
    const r = textOf(
      await tool.execute(
        '1',
        { action: 'save_url', url: 'https://boe.es/ley' },
        undefined as never,
        undefined as never,
      ),
    );
    expect(r).toContain('solo una parte');
    expect(
      textOf(
        await tool.execute(
          '2',
          { action: 'search', query: 'truncated' },
          undefined as never,
          undefined as never,
        ),
      ),
    ).toMatch(/No he encontrado/);
  });

  it('url y título', () => {
    expect(normalizeSavedUrl('https://a.es/b/#x')).toBe('https://a.es/b');
    expect(normalizeSavedUrl('https://a.es/')).toBe('https://a.es/');
    expect(normalizeSavedUrl('javascript:alert(1)')).toBeNull();
    expect(savedPageTitle('https://www.a.es/blog/post', 'sin encabezado')).toBe('a.es/blog/post');
    expect(savedPageTitle('https://a.es/', '## **Mi** título')).toBe('Mi título');
  });
});
