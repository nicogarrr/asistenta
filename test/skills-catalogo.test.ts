import { describe, expect, it, vi } from 'vitest';
import { skillsCatalogReply } from '../src/skills/catalog.js';

const installed = [
  { id: 'resumen-de-email', name: 'Resumen de email', description: 'Resume el correo.' },
];

const catalogJson = JSON.stringify({
  skills: [
    {
      id: 'resumen-de-email',
      name: 'Resumen de email',
      description: 'Resume el correo.',
      url: 'https://example.com/a/SKILL.md',
      source: 'url',
    },
    {
      id: 'revisar-precios',
      name: 'Revisar precios',
      description: 'Avisa si baja.',
      url: 'https://example.com/b/SKILL.md',
      source: 'url',
    },
  ],
});

const okFetch = (body: string) =>
  vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch;

describe('/skills catalogo', () => {
  it('sin PA_SKILLS_CATALOG_URL: solo lo instalado, sin red', async () => {
    const f = vi.fn() as unknown as typeof fetch;
    const r = await skillsCatalogReply(installed, undefined, f);
    expect(r).toContain('Skills instaladas (1):');
    expect(r).toContain('• Resumen de email — Resume el correo.');
    expect(r).toContain('PA_SKILLS_CATALOG_URL');
    expect(f).not.toHaveBeenCalled();
  });

  it('con catálogo: marca lo instalado y da el comando para lo demás', async () => {
    const r = await skillsCatalogReply(
      installed,
      'https://example.com/c.json',
      okFetch(catalogJson),
    );
    expect(r).toContain('Catálogo (2):');
    expect(r).toContain('• Resumen de email ✓ instalada');
    expect(r).not.toContain('/skills instalar https://example.com/a/SKILL.md');
    expect(r).toContain('/skills instalar https://example.com/b/SKILL.md');
  });

  it('URL que no es https: no descarga nada', async () => {
    const f = vi.fn() as unknown as typeof fetch;
    const r = await skillsCatalogReply([], 'http://example.com/c.json', f);
    expect(r).toContain('No tienes skills instaladas.');
    expect(r).toContain(
      'No he podido leer el catálogo de skills (solo leo catálogos desde enlaces https)',
    );
    expect(f).not.toHaveBeenCalled();
  });

  it('sin conexión: frase amable, sin texto en inglés', async () => {
    const f = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const r = await skillsCatalogReply(installed, 'https://example.com/c.json', f);
    expect(r).toContain('No he podido leer el catálogo de skills (sin conexión');
    expect(r).not.toContain('fetch failed');
    expect(r).toContain('• Resumen de email');
  });

  it('catálogo largo: enseña 20 y resume el resto', async () => {
    const skills = Array.from({ length: 25 }, (_, i) => ({
      id: `skill-${i}`,
      name: `Skill ${i}`,
      description: 'x'.repeat(300),
      url: `https://example.com/${i}/SKILL.md`,
      source: 'url',
    }));
    const r = await skillsCatalogReply(
      [],
      'https://example.com/c.json',
      okFetch(JSON.stringify({ skills })),
    );
    expect(r).toContain('… y 5 más');
    expect(r.length).toBeLessThan(4000);
  });
});
