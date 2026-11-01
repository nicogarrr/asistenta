import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PreguntasPendientes } from '../src/daemon/pregunta-pendiente.js';
import { skillsCatalogReply } from '../src/skills/catalog.js';
import { skillPickAnswer } from '../src/skills/search.js';

// Nico (1 nov): que Asistenta hable como un amigo, sin mandarle a comandos.
const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');

const catalog = JSON.stringify({
  skills: [
    {
      id: 'ya',
      name: 'Ya instalada',
      description: 'x',
      url: 'https://example.com/ya/SKILL.md',
      source: 'url',
    },
    {
      id: 'pre',
      name: 'Revisar precios',
      description: 'Avisa si baja.',
      url: 'https://example.com/pre/SKILL.md',
      source: 'url',
    },
    {
      id: 'mail',
      name: 'Resumen de correo',
      description: 'Resume.',
      url: 'https://example.com/mail/SKILL.md',
      source: 'url',
    },
  ],
});
const fakeFetch = (async () =>
  new Response(catalog, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;

describe('/skills catalogo sin «/skills instalar <url>»', () => {
  it('numera lo que no está instalado, pregunta y «la 2» lo instala', async () => {
    let picks: Array<{ name: string; url: string; description: string }> = [];
    const r = await skillsCatalogReply(
      [{ id: 'ya', name: 'Ya instalada' }],
      'https://example.com/c.json',
      fakeFetch,
      (p) => {
        picks = p;
      },
    );
    expect(r).not.toContain('/skills instalar');
    expect(r).toContain('1. Revisar precios — Avisa si baja.');
    expect(r).toContain('2. Resumen de correo — Resume.');
    expect(r).toContain('¿Instalo alguna? Dime su número (la reviso antes de guardarla).');
    expect(picks.map((p) => p.url)).toEqual([
      'https://example.com/pre/SKILL.md',
      'https://example.com/mail/SKILL.md',
    ]);
    const q = new PreguntasPendientes();
    q.ask('c', 'skills', { answer: (t) => skillPickAnswer(picks, t) });
    expect(q.consume('c', 'la 2')).toEqual({
      name: 'skills',
      args: 'instalar https://example.com/mail/SKILL.md',
    });
  });

  it('con todo instalado no pregunta', async () => {
    let called = false;
    const r = await skillsCatalogReply(
      [
        { id: 'ya', name: 'Ya instalada' },
        { id: 'pre', name: 'Revisar precios' },
        { id: 'mail', name: 'Resumen de correo' },
      ],
      'https://example.com/c.json',
      fakeFetch,
      () => {
        called = true;
      },
    );
    expect(r).not.toContain('¿Instalo alguna?');
    expect(called).toBe(false);
  });

  it('el chat pasa la respuesta a /skills instalar', () => {
    expect(cli).toContain('const cmdSkillsCatalog = async (inbound: Inbound): Promise<void> => {');
    expect(cli).toMatch(/process\.env\.PA_SKILLS_CATALOG_URL,\s+undefined,\s+pick,/);
  });
});
