import { describe, expect, it } from 'vitest';
import {
  chatRepos,
  createGithubAvisosTool,
  GithubAvisos,
  parseRepoWatch,
} from '../src/github-avisos.js';
import { Gate } from '../src/permissions.js';

const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => c.text ?? '').join('');

function kvMap() {
  const m = new Map<string, string>();
  return {
    m,
    kv: { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v) },
  };
}

describe('avisos de GitHub pedidos desde el chat', () => {
  it('«avísame de nicogarrr/asistenta» guarda el repo, arranca la vigilancia y la lista lo enseña', async () => {
    const { kv } = kvMap();
    let started = 0;
    const tool = createGithubAvisosTool({
      kv,
      envRepos: () => [{ repo: 'nicogarrr/gerarai', branch: 'main' }],
      allowed: () => true,
      onChange: () => started++,
      everyMs: () => 5 * 60_000,
    });
    const out = textOf(
      await tool.execute('t', {
        accion: 'activar',
        repo: 'https://github.com/nicogarrr/asistenta/pull/12',
      }),
    );
    expect(out).toContain('te aviso por Telegram de nicogarrr/asistenta');
    expect(out).toContain('cada 5 min');
    expect(started).toBe(1);
    expect(chatRepos(kv)).toEqual([{ repo: 'nicogarrr/asistenta', branch: 'main' }]);
    expect(textOf(await tool.execute('t', { accion: 'lista' }))).toBe(
      'Te aviso de GitHub en: nicogarrr/gerarai (rama main, del .env), nicogarrr/asistenta (rama main).',
    );
    expect(
      textOf(await tool.execute('t', { accion: 'quitar', repo: 'nicogarrr/gerarai' })),
    ).toContain('quítalo de ahí');
    expect(
      textOf(await tool.execute('t', { accion: 'quitar', repo: 'NicoGarrr/asistenta' })),
    ).toContain('ya no te aviso');
    expect(chatRepos(kv)).toEqual([]);
  });

  it('fuera del chat del dueño no guarda nada; un texto que no es repo se rechaza', async () => {
    const { kv, m } = kvMap();
    const base = { kv, envRepos: () => [], onChange: () => {}, everyMs: () => 300_000 };
    const ajeno = createGithubAvisosTool({ ...base, allowed: () => false });
    expect(textOf(await ajeno.execute('t', { accion: 'activar', repo: 'a/b' }))).toContain(
      'chat privado',
    );
    const tool = createGithubAvisosTool({ ...base, allowed: () => true });
    expect(textOf(await tool.execute('t', { accion: 'activar', repo: 'mi repo' }))).toContain(
      'dueño/repo',
    );
    expect(m.size).toBe(0);
    expect(parseRepoWatch('x/y@develop')).toEqual({ repo: 'x/y', branch: 'develop' });
  });

  it('el sondeo vigila también los repos del chat y sin ninguno no consulta GitHub', async () => {
    const { kv } = kvMap();
    const paths: string[] = [];
    const fetchFn = (async (url: string | URL) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path === '/user') return Response.json({ login: 'yo' });
      if (path.endsWith('/events')) return Response.json([]);
      return Response.json({ workflow_runs: [] });
    }) as typeof fetch;
    const a = new GithubAvisos({
      config: { repos: [], everyMs: 300_000 },
      fetch: fetchFn,
      kv,
      send: async () => true,
      now: () => 0,
      quiet: () => false,
      token: async () => 'ghp_x',
      extraRepos: () => chatRepos(kv),
    });
    await a.tick();
    expect(paths).toEqual([]);
    kv.set(
      'github-avisos:repos',
      JSON.stringify([{ repo: 'nicogarrr/asistenta', branch: 'main' }]),
    );
    await a.tick();
    expect(paths).toContain('/repos/nicogarrr/asistenta/events');
  });

  it('la Gate: lista es lectura; activar/quitar escribe solo en local', () => {
    const gate = new Gate();
    expect(
      gate.classifyEffect({ tool: 'github_avisos', args: { accion: 'lista' }, actor: 't' }),
    ).toBe('lee');
    expect(
      gate.classifyEffect({ tool: 'github_avisos', args: { accion: 'activar' }, actor: 't' }),
    ).toBe('escribe-local');
  });
});
