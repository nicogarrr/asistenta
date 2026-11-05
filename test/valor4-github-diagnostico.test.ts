import { describe, expect, it } from 'vitest';
import { errorLinesFromLog, GithubAvisos } from '../src/github-avisos.js';

const REPO = 'nicogarrr/asistenta';
const LOG = [
  '2026-11-05T09:00:01.1234567Z ##[group]Run npm test',
  '2026-11-05T09:00:05.0000000Z  ✓ test/ok.test.ts (3 tests)',
  '2026-11-05T09:00:06.0000000Z  FAIL  test/reminder.test.ts > suena a las 5',
  '2026-11-05T09:00:06.1000000Z AssertionError: expected 5 to be 17',
  '2026-11-05T09:00:06.2000000Z     at Object.<anonymous> (test/reminder.test.ts:12:5)',
  '2026-11-05T09:00:07.0000000Z ##[error]Process completed with exit code 1.',
].join('\n');

function setup(token: string | undefined) {
  let pass = 0;
  const calls: Array<{ path: string; auth?: string }> = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const h = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ path, auth: h.Authorization });
    if (path === '/user') return Response.json({ login: 'nicogarrr' });
    if (path.endsWith('/events')) return Response.json([]);
    if (path.endsWith('/runs/9/jobs'))
      return Response.json({
        jobs: [
          {
            id: 77,
            name: 'test',
            conclusion: 'failure',
            steps: [{ name: 'npm test', conclusion: 'failure' }],
          },
        ],
      });
    if (path.endsWith('/jobs/77/logs')) return new Response(LOG, { status: 200 });
    const runs =
      pass > 1
        ? [
            {
              id: 9,
              status: 'completed',
              conclusion: 'failure',
              created_at: '2026-11-05T09:00:00Z',
              name: 'CI',
              workflow_id: 1,
              html_url: 'https://github.com/x',
            },
          ]
        : [];
    return Response.json({ workflow_runs: runs });
  }) as typeof fetch;
  const kv = new Map<string, string>();
  const a = new GithubAvisos({
    config: { repos: [{ repo: REPO, branch: 'main' }], everyMs: 300_000 },
    fetch: fetchFn,
    kv: { get: (k) => kv.get(k) ?? null, set: (k, v) => void kv.set(k, v) },
    send: async () => true,
    now: () => 0,
    quiet: () => false,
    token: async () => token,
  });
  return {
    calls,
    tick: async () => {
      pass++;
      return a.tick();
    },
  };
}

describe('CI en rojo: primer diagnóstico con las líneas de error del log', () => {
  it('el aviso trae el test que falló y la aserción, sin la pila ni «exit code 1»', async () => {
    const t = setup('ghp_x');
    await t.tick();
    const text = await t.tick();
    expect(text).toContain('(falló: test › npm test)');
    expect(text).toContain(
      '🧾 FAIL test/reminder.test.ts > suena a las 5 / AssertionError: expected 5 to be 17',
    );
    expect(text).not.toContain('exit code');
    expect(text).not.toContain('at Object');
    expect(t.calls.find((c) => c.path.endsWith('/logs'))?.auth).toBe('Bearer ghp_x');
  });

  it('sin clave no pide el log (GitHub no lo da) y el aviso sale igual', async () => {
    const t = setup(undefined);
    await t.tick();
    const text = await t.tick();
    expect(text).toContain('(falló: test › npm test)');
    expect(text).not.toContain('🧾');
    expect(t.calls.some((c) => c.path.endsWith('/logs'))).toBe(false);
  });

  it('errorLinesFromLog se queda con las 3 últimas, sin repetir', () => {
    const log = ['error A', 'error B', 'error A', 'nada', 'error C', 'error D'].join('\n');
    expect(errorLinesFromLog(log)).toBe('error A / error C / error D');
    expect(errorLinesFromLog('todo bien\n✓ ok')).toBe('');
  });
});
