/**
 * GitHub: «revisa este PR» ya leía PRs y commits por la API. Ahora también:
 * - una comparación (`/compare/main...rama`): commits, ficheros, avisos y diff, en vez de la
 *   página HTML;
 * - una issue (`/issues/N`): descripción, estado, etiquetas y últimos comentarios; si el número
 *   es de una PR, se revisa como PR;
 * - cuando GitHub omite el diff de un fichero grande (viene sin `patch`) o corta la lista de
 *   ficheros, lo avisa: antes el resumen parecía completo sin haber visto esos cambios.
 * API falsa.
 */
import { describe, expect, it } from 'vitest';
import { createFetchTool } from '../src/tools/fetch.js';
import { githubReviewText, parseGithubUrl } from '../src/tools/github-review.js';

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

const API = 'https://api.github.com/repos/o/r';

describe('GitHub: comparaciones, issues y diffs omitidos', () => {
  it('reconoce enlaces de comparación e issues', () => {
    expect(parseGithubUrl('https://github.com/o/r/compare/main...feat/voz')).toEqual({
      kind: 'compare',
      owner: 'o',
      repo: 'r',
      ref: 'main...feat/voz',
    });
    expect(parseGithubUrl('https://github.com/o/r/compare/v1.2..v1.3')?.ref).toBe('v1.2...v1.3');
    expect(parseGithubUrl('https://github.com/o/r/compare/solo-una-rama')).toBeNull();
    expect(parseGithubUrl('https://github.com/o/r/issues/42')).toEqual({
      kind: 'issue',
      owner: 'o',
      repo: 'r',
      ref: '42',
    });
    expect(parseGithubUrl('https://github.com/o/r/issues')).toBeNull();
  });

  it('una comparación trae commits, ficheros, avisos y diff', async () => {
    const text = await githubReviewText(
      { kind: 'compare', owner: 'o', repo: 'r', ref: 'main...feat' },
      {
        fetchFn: fakeFetch({
          [`${API}/compare/main...feat`]: {
            status: 'ahead',
            ahead_by: 2,
            behind_by: 0,
            total_commits: 2,
            commits: [
              {
                sha: 'aaaaaaa111',
                commit: { message: 'Primero\n\ncuerpo', author: { name: 'Ana' } },
              },
              { sha: 'bbbbbbb222', commit: { message: 'Segundo', author: { name: 'Luis' } } },
            ],
            files: [
              {
                filename: 'src/a.ts',
                status: 'modified',
                additions: 2,
                deletions: 1,
                patch: '@@ -1 +1,2 @@\n+const a = 1;',
              },
            ],
          },
        }) as never,
      },
    );
    expect(text).toContain('Comparación main...feat de o/r (por delante)');
    expect(text).toContain('feat lleva 2 commits por delante y 0 por detrás de main');
    expect(text).toContain('- aaaaaaa Primero (Ana)');
    expect(text).toContain('- bbbbbbb Segundo (Luis)');
    expect(text).toContain('Cambia código sin añadir ni tocar tests.');
    expect(text).toContain('+const a = 1;');
  });

  it('una issue trae estado, etiquetas, descripción y los últimos comentarios', async () => {
    const seen: string[] = [];
    const text = await githubReviewText(
      { kind: 'issue', owner: 'o', repo: 'r', ref: '42' },
      {
        fetchFn: fakeFetch(
          {
            [`${API}/issues/42`]: {
              title: 'La voz no arranca',
              user: { login: 'nico' },
              state: 'closed',
              state_reason: 'completed',
              labels: [{ name: 'bug' }, { name: 'voz' }],
              comments: 2,
              created_at: '2026-11-01T10:00:00Z',
              body: 'Con tildes en la ruta falla.',
            },
            [`${API}/issues/42/comments?per_page=100`]: [
              {
                user: { login: 'ana' },
                created_at: '2026-11-02T10:00:00Z',
                body: 'Lo reproduzco.',
              },
              {
                user: { login: 'luis' },
                created_at: '2026-11-03T10:00:00Z',
                body: 'Arreglado en #1997.',
              },
            ],
          },
          seen,
        ) as never,
      },
    );
    expect(text).toContain('Issue #42 de o/r: «La voz no arranca»');
    expect(text).toContain(
      'Autor: nico · Estado: cerrada (resuelta) · 2026-11-01 · Etiquetas: bug, voz · 2 comentarios',
    );
    expect(text).toContain('Con tildes en la ruta falla.');
    expect(text).toContain('- luis (2026-11-03): Arreglado en #1997.');
    expect(seen).toHaveLength(2);
  });

  it('un enlace /issues/N que es una PR se revisa como PR', async () => {
    const seen: string[] = [];
    const text = await githubReviewText(
      { kind: 'issue', owner: 'o', repo: 'r', ref: '7' },
      {
        fetchFn: fakeFetch(
          {
            [`${API}/issues/7`]: { title: 'x', pull_request: { url: 'u' } },
            [`${API}/pulls/7`]: {
              title: 'Una PR',
              user: { login: 'a' },
              state: 'open',
              changed_files: 0,
            },
            [`${API}/pulls/7/files?per_page=100`]: [],
          },
          seen,
        ) as never,
      },
    );
    expect(text).toContain('Pull request #7 de o/r: «Una PR»');
  });

  it('avisa cuando GitHub omite el diff de un fichero grande o corta la lista', async () => {
    const files = [
      { filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, patch: '+x' },
      { filename: 'test/a.test.ts', status: 'modified', additions: 1, deletions: 0, patch: '+t' },
      { filename: 'data/enorme.json', status: 'modified', additions: 25000, deletions: 3 },
    ];
    const text = await githubReviewText(
      { kind: 'pull', owner: 'o', repo: 'r', ref: '9' },
      {
        fetchFn: fakeFetch({
          [`${API}/pulls/9`]: {
            title: 'Datos',
            user: { login: 'a' },
            state: 'open',
            changed_files: 140,
          },
          [`${API}/pulls/9/files?per_page=100`]: files,
        }) as never,
      },
    );
    expect(text).toContain(
      'GitHub no da el diff de 1 fichero por ser demasiado grande (data/enorme.json +25000 −3)',
    );
    expect(text).toContain(
      '- data/enorme.json (modified, +25000 −3) [sin diff: demasiado grande para GitHub]',
    );
    expect(text).toContain(
      'GitHub solo ha devuelto 3 de 140 ficheros: el resto no se ha revisado.',
    );
  });

  it('la herramienta fetch lee una issue por la API y lo dice al modelo', async () => {
    const calls: string[] = [];
    const tool = createFetchTool(20_000, {
      github: async (t) => {
        calls.push(`${t.kind}:${t.ref}`);
        return 'Issue #42 de o/r: «La voz no arranca»';
      },
    });
    const r = await tool.execute('id', { url: 'https://github.com/o/r/issues/42' } as never);
    const text = (r.content[0] as { text: string }).text;
    expect(calls).toEqual(['issue:42']);
    expect(text).toContain('GitHub issue https://github.com/o/r/issues/42');
    expect(text).toContain('what is still pending');
  });
});
