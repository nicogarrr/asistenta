import { describe, expect, it } from 'vitest';
import { skillsSearchReply } from '../src/cli.js';
import {
  fetchSkillIndex,
  formatSkillSearch,
  parseSkillIndex,
  searchSkillIndex,
} from '../src/skills/search.js';

const index = [
  {
    name: 'Diagnosticar bugs',
    url: 'https://github.com/a/b/raw/main/bugs/SKILL.md',
    description: 'Encuentra la causa de un fallo',
  },
  {
    name: 'TDD',
    url: 'https://example.com/tdd/SKILL.md',
    description: 'Escribe primero el test que falla',
  },
  { name: 'Sin https', url: 'http://example.com/SKILL.md' },
  { name: 'Con credenciales', url: 'https://user:pw@example.com/SKILL.md' },
  { name: '', url: 'https://example.com/vacio/SKILL.md' },
  { name: 'Repetida', url: 'https://example.com/tdd/SKILL.md' },
  { name: 'Raro\u202ecod', url: 'https://example.com/raro/SKILL.md', description: 'x'.repeat(500) },
  'no es objeto',
];

describe('F15 /skills buscar: índice', () => {
  it('descarta URL no https, con credenciales, nombres vacíos y repetidas', () => {
    const entries = parseSkillIndex(index);
    expect(entries.map((e) => e.name)).toEqual(['Diagnosticar bugs', 'TDD', 'Raro cod']);
    expect(entries[2]?.description.length).toBe(160);
  });

  it('acepta { skills: [...] } y rechaza lo que no es lista', () => {
    expect(parseSkillIndex({ skills: index })).toHaveLength(3);
    expect(() => parseSkillIndex({ foo: 1 })).toThrow(/no es una lista/);
  });

  it('busca sin tildes ni mayúsculas, nombre primero, máximo 10', () => {
    const entries = parseSkillIndex(index);
    expect(searchSkillIndex(entries, 'DIAGNÓSTICAR').map((e) => e.name)).toEqual([
      'Diagnosticar bugs',
    ]);
    expect(searchSkillIndex(entries, 'test falla').map((e) => e.name)).toEqual(['TDD']);
    expect(searchSkillIndex(entries, '   ')).toEqual([]);
    const many = parseSkillIndex(
      Array.from({ length: 30 }, (_, i) => ({ name: `skill ${i}`, url: `https://e.com/${i}` })),
    );
    expect(searchSkillIndex(many, 'skill', 50)).toHaveLength(10);
  });

  it('descarga con plazo, solo https y con tamaño máximo', async () => {
    const ok = (body: string, url = 'https://idx.example/skills.json') =>
      (async () => {
        const r = new Response(body, { status: 200 });
        Object.defineProperty(r, 'url', { value: url });
        return r;
      }) as unknown as typeof fetch;
    await expect(
      fetchSkillIndex('http://idx.example/x.json', { fetchImpl: ok('[]') }),
    ).rejects.toThrow(/https/);
    expect(
      await fetchSkillIndex('https://idx.example/skills.json', {
        fetchImpl: ok(JSON.stringify(index)),
      }),
    ).toHaveLength(3);
    await expect(
      fetchSkillIndex('https://idx.example/skills.json', {
        fetchImpl: ok('x'.repeat(100)),
        maxBytes: 10,
      }),
    ).rejects.toThrow(/demasiado grande/);
    await expect(
      fetchSkillIndex('https://idx.example/skills.json', { fetchImpl: ok('{nope') }),
    ).rejects.toThrow(/JSON/);
    await expect(
      fetchSkillIndex('https://idx.example/skills.json', {
        fetchImpl: ok('[]', 'http://evil.example/skills.json'),
      }),
    ).rejects.toThrow(/fuera de https/);
  });

  it('la respuesta lista nombre y URL y recuerda cómo instalar', () => {
    const out = formatSkillSearch('tdd', parseSkillIndex(index).slice(1, 2));
    expect(out).toContain('1. TDD — Escribe primero el test que falla');
    expect(out).toContain('https://example.com/tdd/SKILL.md');
    expect(out).toContain('pásame su enlace con /skills instalar');
    expect(formatSkillSearch('nada', [])).toContain('No hay skills');
  });

  it('/skills buscar: sin índice explica cómo configurarlo; con índice lista resultados', async () => {
    expect(await skillsSearchReply('tdd', undefined)).toContain('PA_SKILLS_INDEX_URL');
    expect(await skillsSearchReply('', 'https://idx.example/s.json')).toBe('¿Qué habilidad busco?');
    const fetchImpl = (async () => new Response(JSON.stringify(index))) as unknown as typeof fetch;
    const out = await skillsSearchReply('tdd', 'https://idx.example/s.json', fetchImpl);
    expect(out).toContain('1. TDD');
    const bad = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    expect(await skillsSearchReply('tdd', 'https://idx.example/s.json', bad)).toContain('404');
  });
});
