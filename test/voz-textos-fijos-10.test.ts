import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fetchCatalog } from '../src/skills/catalog.js';
import { fetchSkillMarkdown, installSkill, secondsText, sizeText } from '../src/skills/import.js';

// Nico (31 oct): que Asistenta hable como en un chat. «/skills instalar» y
// «/skills catalogo» contaban los fallos con «frontmatter YAML», «content-type»,
// «timeout de 15000 ms» o «estado 404». Ahora, en castellano llano.
const respond = (body: string, init: ResponseInit = {}): typeof fetch =>
  (async () => new Response(body, init)) as unknown as typeof fetch;

describe('textos fijos sin jerga (10): skills', () => {
  it('una skill sin cabecera no habla de «frontmatter YAML»', async () => {
    const err = await installSkill('# hola', async () => undefined).catch((e: unknown) => e);
    const reason = String((err as { reason?: string }).reason);
    expect(reason).toBe('no parece una skill: falta la cabecera entre líneas ---');
    expect(reason).not.toMatch(/frontmatter|YAML/);
  });

  it('un enlace que da una web no habla de «content-type»', async () => {
    const fetchImpl = respond('<html></html>', { headers: { 'content-type': 'text/html' } });
    await expect(fetchSkillMarkdown('https://example.com/SKILL.md', { fetchImpl })).rejects.toThrow(
      'Ese enlace no lleva a un archivo de texto (parece una web u otro tipo de archivo)',
    );
  });

  it('un 404 se dice claro, sin «estado»', async () => {
    const fetchImpl = respond('no', { status: 404 });
    await expect(fetchSkillMarkdown('https://example.com/SKILL.md', { fetchImpl })).rejects.toThrow(
      'No hay nada en ese enlace (error 404)',
    );
  });

  it('tiempos y tamaños en segundos y KB, no en ms ni bytes sueltos', () => {
    expect(secondsText(15_000)).toBe('15 s');
    expect(sizeText(256 * 1024)).toBe('256 KB');
    const src =
      readFileSync('src/skills/import.ts', 'utf8') + readFileSync('src/skills/catalog.ts', 'utf8');
    expect(src).not.toContain('(timeout) de');
    expect(src).not.toContain('respondió con estado');
  });

  it('catálogo: sin «JSON válido» ni «URL»', async () => {
    const bad = await fetchCatalog('https://example.com/c.json', { fetchImpl: respond('nada') });
    expect(bad).toEqual({ ok: false, reason: 'el catálogo no tiene el formato esperado' });
    const notUrl = await fetchCatalog('no-es-un-enlace', { fetchImpl: respond('nada') });
    expect(notUrl).toEqual({ ok: false, reason: 'el enlace del catálogo no es válido' });
  });
});
