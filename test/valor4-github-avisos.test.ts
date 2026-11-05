import { describe, expect, it } from 'vitest';
import {
  composeNotices,
  eventNotice,
  GithubAvisos,
  type GithubAvisosConfig,
  githubAvisosConfig,
} from '../src/github-avisos.js';

type Reply = { status?: number; body?: unknown; etag?: string; headers?: Record<string, string> };

function fakeGithub() {
  const routes = new Map<string, Reply>();
  const calls: Array<{ path: string; etag?: string; auth?: string }> = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const h = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ path: u.pathname, etag: h['If-None-Match'], auth: h.Authorization });
    const r = routes.get(u.pathname);
    if (!r) return new Response('{}', { status: 404 });
    if (r.etag && h['If-None-Match'] === r.etag)
      return new Response(null, { status: 304, headers: { etag: r.etag } });
    return new Response(r.status === 304 ? null : JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { ...(r.etag ? { etag: r.etag } : {}), ...(r.headers ?? {}) },
    });
  }) as typeof fetch;
  return { routes, calls, fetchFn };
}

const REPO = 'nicogarrr/asistenta';
const ev = (
  id: string,
  type: string,
  actor: string,
  payload: unknown,
  at = '2026-11-05T08:00:00Z',
) => ({
  id,
  type,
  actor: { login: actor },
  payload,
  created_at: at,
});
const run = (id: number, conclusion: string, at: string, extra: Record<string, unknown> = {}) => ({
  id,
  run_attempt: 1,
  workflow_id: 7,
  name: 'CI',
  status: 'completed',
  conclusion,
  created_at: at,
  html_url: `https://github.com/${REPO}/actions/runs/${id}`,
  head_commit: { message: 'Arregla los avisos\n\ncuerpo' },
  ...extra,
});

function setup(
  config?: Partial<GithubAvisosConfig>,
  opts: { quiet?: boolean; token?: string } = {},
) {
  const gh = fakeGithub();
  const store = new Map<string, string>();
  const sent: string[] = [];
  let now = Date.parse('2026-11-05T10:00:00Z');
  let sendOk = true;
  gh.routes.set('/user', { body: { login: 'nicogarrr' } });
  gh.routes.set(`/repos/${REPO}/events`, { body: [], etag: '"e0"' });
  gh.routes.set(`/repos/${REPO}/actions/runs`, { body: { workflow_runs: [] }, etag: '"r0"' });
  const avisos = new GithubAvisos({
    config: { repos: [{ repo: REPO, branch: 'main' }], everyMs: 5 * 60_000, ...config },
    fetch: gh.fetchFn,
    kv: { get: (k) => store.get(k) ?? null, set: (k, v) => void store.set(k, v) },
    send: async (t) => {
      if (!sendOk) return false;
      sent.push(t);
      return true;
    },
    now: () => now,
    quiet: () => opts.quiet === true,
    token: async () => ('token' in opts ? opts.token : 'ghp_x'),
  });
  return {
    gh,
    store,
    sent,
    avisos,
    advance: (ms: number) => {
      now += ms;
    },
    setSendOk: (v: boolean) => {
      sendOk = v;
    },
  };
}

describe('avisos de GitHub: configuración', () => {
  it('apagado por defecto y con «off»', () => {
    expect(githubAvisosConfig({})).toBeNull();
    expect(githubAvisosConfig({ PA_GITHUB_AVISOS: 'off' })).toBeNull();
  });

  it('acepta repos, enlaces de GitHub y @rama; descarta lo que no es un repo', () => {
    const c = githubAvisosConfig({
      PA_GITHUB_AVISOS:
        'nicogarrr/asistenta, https://github.com/nicogarrr/gerarai.git@develop; basura',
    });
    expect(c?.repos).toEqual([
      { repo: 'nicogarrr/asistenta', branch: 'main' },
      { repo: 'nicogarrr/gerarai', branch: 'develop' },
    ]);
    expect(c?.everyMs).toBe(5 * 60_000);
  });

  it('PA_AHORRO=1 sondea al menos 3 veces menos (mínimo 15 min)', () => {
    expect(githubAvisosConfig({ PA_GITHUB_AVISOS: REPO, PA_AHORRO: '1' })?.everyMs).toBe(
      15 * 60_000,
    );
    expect(
      githubAvisosConfig({ PA_GITHUB_AVISOS: REPO, PA_AHORRO: 'on', PA_GITHUB_AVISOS_MIN: '10' })
        ?.everyMs,
    ).toBe(30 * 60_000);
  });
});

describe('avisos de GitHub: sondeo', () => {
  it('la primera pasada solo toma nota; después avisa de PR, issue, comentario y CI rojo con el paso que falló', async () => {
    const t = setup();
    t.gh.routes.set(`/repos/${REPO}/events`, {
      etag: '"e1"',
      body: [
        ev('1', 'PullRequestEvent', 'otra', {
          action: 'opened',
          pull_request: { number: 1, title: 'Vieja' },
        }),
      ],
    });
    t.gh.routes.set(`/repos/${REPO}/actions/runs`, {
      etag: '"r1"',
      body: { workflow_runs: [run(100, 'failure', '2026-11-05T07:00:00Z')] },
    });
    expect(await t.avisos.tick()).toBeNull();
    expect(t.sent).toEqual([]);

    t.gh.routes.set(`/repos/${REPO}/events`, {
      etag: '"e2"',
      body: [
        ev('1', 'PullRequestEvent', 'otra', {
          action: 'opened',
          pull_request: { number: 1, title: 'Vieja' },
        }),
        ev('2', 'PullRequestEvent', 'ana', {
          action: 'opened',
          pull_request: {
            number: 12,
            title: 'Añade modo oscuro',
            html_url: `https://github.com/${REPO}/pull/12`,
          },
        }),
        ev('3', 'PullRequestEvent', 'nicogarrr', {
          action: 'opened',
          pull_request: { number: 13, title: 'Mía' },
        }),
        ev('4', 'IssuesEvent', 'luis', {
          action: 'opened',
          issue: {
            number: 14,
            title: 'No arranca en Windows 11',
            html_url: `https://github.com/${REPO}/issues/14`,
          },
        }),
        ev('5', 'IssueCommentEvent', 'ana', {
          action: 'created',
          issue: { number: 12, title: 'Añade modo oscuro', pull_request: {} },
          comment: {
            body: '¿Lo pruebas\nen el móvil?',
            html_url: `https://github.com/${REPO}/pull/12#c1`,
          },
        }),
      ],
    });
    t.gh.routes.set(`/repos/${REPO}/actions/runs`, {
      etag: '"r2"',
      body: {
        workflow_runs: [
          run(100, 'failure', '2026-11-05T07:00:00Z'),
          run(101, 'failure', '2026-11-05T09:00:00Z'),
        ],
      },
    });
    t.gh.routes.set(`/repos/${REPO}/actions/runs/101/jobs`, {
      body: {
        jobs: [
          { name: 'lint', conclusion: 'success', steps: [] },
          {
            name: 'test',
            conclusion: 'failure',
            steps: [
              { name: 'npm ci', conclusion: 'success' },
              { name: 'npm test', conclusion: 'failure' },
            ],
          },
        ],
      },
    });
    t.advance(5 * 60_000);
    const text = await t.avisos.tick();
    expect(t.sent).toHaveLength(1);
    expect(text).toContain('🆕 PR #12 en nicogarrr/asistenta de @ana: «Añade modo oscuro»');
    expect(text).toContain('🆕 Issue #14');
    expect(text).toContain('💬 @ana comentó en la PR #12');
    expect(text).toContain('«¿Lo pruebas en el móvil?»');
    expect(text).toContain(
      '🔴 CI en rojo en main · nicogarrr/asistenta: CI — «Arregla los avisos» (falló: test › npm test)',
    );
    expect(text).toContain('/actions/runs/101');
    expect(text).not.toContain('Vieja');
    expect(text).not.toContain('Mía');
    expect(text).not.toContain('runs/100');
  });

  it('manda la ETag guardada; un 304 no avisa ni gasta nada más', async () => {
    const t = setup();
    await t.avisos.tick();
    t.advance(5 * 60_000);
    const before = t.gh.calls.length;
    expect(await t.avisos.tick()).toBeNull();
    const again = t.gh.calls.slice(before);
    expect(again.find((c) => c.path.endsWith('/events'))?.etag).toBe('"e0"');
    expect(again.find((c) => c.path.endsWith('/actions/runs'))?.etag).toBe('"r0"');
    expect(t.sent).toEqual([]);
  });

  it('si Telegram no acepta el aviso, la siguiente pasada lo vuelve a mandar (una sola vez)', async () => {
    const t = setup();
    await t.avisos.tick();
    t.gh.routes.set(`/repos/${REPO}/events`, {
      etag: '"e9"',
      body: [
        ev('9', 'IssuesEvent', 'luis', { action: 'opened', issue: { number: 3, title: 'Fallo' } }),
      ],
    });
    t.setSendOk(false);
    t.advance(5 * 60_000);
    expect(await t.avisos.tick()).toBeNull();
    t.setSendOk(true);
    t.advance(5 * 60_000);
    expect(await t.avisos.tick()).toContain('Issue #3');
    t.advance(5 * 60_000);
    expect(await t.avisos.tick()).toBeNull();
    expect(t.sent).toHaveLength(1);
  });

  it('avisa cuando el CI vuelve a verde tras un rojo', async () => {
    const t = setup();
    t.gh.routes.set(`/repos/${REPO}/actions/runs`, {
      etag: '"a"',
      body: { workflow_runs: [run(1, 'failure', '2026-11-05T07:00:00Z')] },
    });
    await t.avisos.tick();
    t.gh.routes.set(`/repos/${REPO}/actions/runs`, {
      etag: '"b"',
      body: {
        workflow_runs: [
          run(1, 'failure', '2026-11-05T07:00:00Z'),
          run(2, 'success', '2026-11-05T08:00:00Z'),
        ],
      },
    });
    t.advance(5 * 60_000);
    expect(await t.avisos.tick()).toContain('🟢 CI otra vez en verde en main');
  });

  it('GitHub limita (403): espera al reset sin consultar entretanto', async () => {
    const t = setup();
    const reset = Math.floor(Date.parse('2026-11-05T10:40:00Z') / 1000);
    t.gh.routes.set(`/repos/${REPO}/events`, {
      status: 403,
      body: { message: 'API rate limit exceeded' },
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
    });
    expect(await t.avisos.tick()).toBeNull();
    expect(t.avisos.nextDelayMs()).toBeGreaterThanOrEqual(40 * 60_000);
    const n = t.gh.calls.length;
    t.advance(10 * 60_000);
    await t.avisos.tick();
    expect(t.gh.calls.length).toBe(n);
  });

  it('un fallo de red dobla la espera; en horas de silencio no consulta', async () => {
    const t = setup();
    t.gh.routes.set(`/repos/${REPO}/events`, { status: 502 });
    await t.avisos.tick();
    expect(t.avisos.nextDelayMs()).toBe(10 * 60_000);
    const q = setup(undefined, { quiet: true });
    await q.avisos.tick();
    expect(q.gh.calls).toEqual([]);
  });

  it('sin clave consulta como mucho cada 10 min y no pide /user', async () => {
    const t = setup(undefined, { token: undefined });
    await t.avisos.tick();
    expect(t.gh.calls.some((c) => c.path === '/user')).toBe(false);
    expect(t.gh.calls.every((c) => c.auth === undefined)).toBe(true);
    expect(t.avisos.nextDelayMs()).toBe(10 * 60_000);
  });

  it('clave rechazada (401): un aviso y se para', async () => {
    const t = setup();
    t.gh.routes.set('/user', { status: 401, body: { message: 'Bad credentials' } });
    await t.avisos.tick();
    expect(t.sent[0]).toContain('GitHub no acepta la clave');
    expect(t.avisos.disabled).toBe(true);
  });
});

describe('avisos de GitHub: textos', () => {
  it('ignora lo que hace uno mismo y acciones que no son de apertura', () => {
    expect(
      eventNotice(
        REPO,
        ev('1', 'PullRequestEvent', 'NicoGarrr', { action: 'opened', pull_request: {} }),
        'nicogarrr',
      ),
    ).toBeNull();
    expect(
      eventNotice(REPO, ev('2', 'IssuesEvent', 'x', { action: 'closed', issue: {} })),
    ).toBeNull();
    expect(eventNotice(REPO, ev('3', 'WatchEvent', 'x', {}))).toBeNull();
  });

  it('junta como mucho 8 avisos y dice cuántos más hay', () => {
    const text = composeNotices(Array.from({ length: 10 }, (_, i) => `aviso ${i}`));
    expect(text.startsWith('GitHub:')).toBe(true);
    expect(text).toContain('aviso 7');
    expect(text).not.toContain('aviso 8');
    expect(text).toContain('…y 2 más en GitHub.');
  });
});
