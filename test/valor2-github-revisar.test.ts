/**
 * «Revisa este PR»: un enlace de GitHub a una pull request o a un commit se leía como página
 * (HTML casi todo menú) y el asistente no veía el diff. Ahora `fetch` lo lee por la API de
 * GitHub y devuelve título, autor, estado, ficheros con +/−, avisos automáticos de riesgo y
 * el diff, para resumir y señalar riesgos. API falsa.
 */
import { describe, expect, it } from 'vitest';
import { createFetchTool } from '../src/tools/fetch.js';
import { githubReviewText, parseGithubUrl, riskFlags } from '../src/tools/github-review.js';

const PR = {
  title: 'Añade login con Google',
  user: { login: 'ana' },
  state: 'open',
  merged: false,
  draft: false,
  mergeable: false,
  base: { ref: 'main' },
  head: { ref: 'login-google' },
  commits: 3,
  changed_files: 3,
  additions: 40,
  deletions: 2,
  body: 'Permite entrar con Google.',
};
const FILES = [
  {
    filename: 'src/auth/google.ts',
    status: 'added',
    additions: 30,
    deletions: 0,
    patch: '@@ -0,0 +1 @@\n+export const login = 1;',
  },
  {
    filename: 'package.json',
    status: 'modified',
    additions: 1,
    deletions: 0,
    patch: '+"googleapis": "^1"',
  },
  { filename: '.github/workflows/ci.yml', status: 'modified', additions: 9, deletions: 2 },
];

function fakeFetch(routes: Record<string, unknown>, seen: string[] = []) {
  return async (url: string) => {
    seen.push(url);
    const body = routes[url];
    if (body === undefined) return new Response('no', { status: 404 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

describe('revisar un enlace de GitHub', () => {
  it('reconoce PRs y commits de github.com, y nada más', () => {
    expect(parseGithubUrl('https://github.com/nicogarrr/asistenta/pull/1989')).toEqual({
      kind: 'pull',
      owner: 'nicogarrr',
      repo: 'asistenta',
      ref: '1989',
    });
    expect(parseGithubUrl('https://github.com/o/r/pull/7/files')?.ref).toBe('7');
    expect(parseGithubUrl('https://github.com/o/r/commit/0621ce84a1')).toEqual({
      kind: 'commit',
      owner: 'o',
      repo: 'r',
      ref: '0621ce84a1',
    });
    expect(parseGithubUrl('https://github.com/o/r/issues/3')).toBeNull();
    expect(parseGithubUrl('https://github.com/o/r')).toBeNull();
    expect(parseGithubUrl('https://gitlab.com/o/r/pull/1')).toBeNull();
  });

  it('la PR llega con cabecera, avisos de riesgo, ficheros y diff', async () => {
    const seen: string[] = [];
    const text = await githubReviewText(
      { kind: 'pull', owner: 'o', repo: 'r', ref: '5' },
      {
        fetchFn: fakeFetch(
          {
            'https://api.github.com/repos/o/r/pulls/5': PR,
            'https://api.github.com/repos/o/r/pulls/5/files?per_page=100': FILES,
          },
          seen,
        ) as never,
      },
    );
    expect(text).toContain('Pull request #5 de o/r: «Añade login con Google»');
    expect(text).toContain('Autor: ana · Estado: abierta · main ← login-google');
    expect(text).toContain('Cambia dependencias (package.json)');
    expect(text).toContain('Toca CI o despliegue (.github/workflows/ci.yml)');
    expect(text).toContain(
      'Toca ficheros de secretos, autenticación o permisos (src/auth/google.ts)',
    );
    expect(text).toContain('Cambia código sin añadir ni tocar tests.');
    expect(text).toContain('tiene conflictos');
    expect(text).toContain('- src/auth/google.ts (added, +30 −0)');
    expect(text).toContain('+export const login = 1;');
    expect(seen).toHaveLength(2);
  });

  it('un commit también, y el diff se corta al límite', async () => {
    const text = await githubReviewText(
      { kind: 'commit', owner: 'o', repo: 'r', ref: 'abcdef1234' },
      {
        maxChars: 400,
        fetchFn: fakeFetch({
          'https://api.github.com/repos/o/r/commits/abcdef1234': {
            commit: {
              message: 'Arregla rutinas\n\ndetalle',
              author: { name: 'Nico', date: '2026-11-05T01:00:00Z' },
            },
            stats: { additions: 5, deletions: 1 },
            files: [
              { filename: 'src/cron/a.ts', additions: 4, deletions: 1, patch: 'x'.repeat(2000) },
              { filename: 'test/a.test.ts', additions: 1, deletions: 0 },
            ],
          },
        }) as never,
      },
    );
    expect(text).toContain('Commit abcdef1 de o/r: «Arregla rutinas»');
    expect(text).toContain('Autor: Nico · 2026-11-05 · +5 −1');
    expect(text).toContain('- Ninguno.');
    expect(text).toContain('[diff cortado a 400 caracteres]');
  });

  it('avisos: migraciones, borrados y PR enorme; con tests no avisa de «sin tests»', () => {
    const flags = riskFlags([
      { filename: 'db/migrations/0130.sql', additions: 10, deletions: 0 },
      { filename: 'src/viejo.ts', status: 'removed', additions: 0, deletions: 400 },
      { filename: 'src/nuevo.ts', additions: 700, deletions: 0 },
      { filename: 'test/nuevo.test.ts', additions: 20, deletions: 0 },
    ]);
    expect(flags.join('\n')).toContain('migraciones');
    expect(flags.join('\n')).toContain('Borra 1 fichero (src/viejo.ts)');
    expect(flags.join('\n')).toContain('Quita muchas líneas (−400)');
    expect(flags.join('\n')).toContain('Es grande');
    expect(flags.join('\n')).not.toContain('sin añadir ni tocar tests');
  });

  it('la herramienta fetch usa la API para un enlace de PR y vuelve a la página si falla', async () => {
    const tool = createFetchTool(20_000, {
      github: async (t) => `RESUMEN ${t.kind} ${t.ref}`,
    });
    const out = await tool.execute('1', { url: 'https://github.com/o/r/pull/9' } as never);
    const text = (out.content[0] as { text: string }).text;
    expect(text).toContain('RESUMEN pull 9');
    expect(text).toContain('read through the GitHub API');
    expect(tool.description).toContain('revisa este PR');
  });
});
