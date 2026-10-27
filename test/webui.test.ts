import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWebUi, type WebUiDeps } from '../src/webui/server.js';

const TOKEN = 'token-de-prueba-123';

const llamadas: {
  sesiones: Array<string | undefined>;
  memoria: Array<string | undefined>;
} = { sesiones: [], memoria: [] };

const deps: WebUiDeps = {
  token: TOKEN,
  status: () => ({ ok: true, tareas: 2 }),
  sessions: (query) => {
    llamadas.sesiones.push(query);
    return { sessions: [{ id: 's-1', title: query ?? 'todas' }] };
  },
  memory: (scope) => {
    llamadas.memoria.push(scope);
    return { scope: scope ?? 'global', items: [] };
  },
  auditVerify: async () => ({ ok: true, comprobados: 3 }),
  approve: async (id) => id === 'vivo',
};

let ui: Awaited<ReturnType<typeof startWebUi>>;

beforeAll(async () => {
  ui = await startWebUi(deps);
});

afterAll(async () => {
  await ui.close();
});

function urlFor(path: string): string {
  return new URL(path, ui.url).toString();
}

async function get(path: string, token?: string): Promise<Response> {
  return fetch(urlFor(path), {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
}

describe('panel web local', () => {
  it('sirve la página con el manifest, la CSP y el icono', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain('Asistenta');
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('apple-touch-icon');
    expect(html).toContain('/sw.js');
  });

  it('protege /api/status con Bearer', async () => {
    const sinToken = await get('/api/status');
    expect(sinToken.status).toBe(401);
    expect(sinToken.headers.get('cache-control')).toBe('no-store');
    expect(sinToken.headers.get('www-authenticate')).toContain('Bearer');

    const tokenMalo = await get('/api/status', 'otro-token');
    expect(tokenMalo.status).toBe(401);

    const bien = await get('/api/status', TOKEN);
    expect(bien.status).toBe(200);
    await expect(bien.json()).resolves.toMatchObject({ ok: true, tareas: 2 });
  });

  it('pasa q a sessions y scope a memory', async () => {
    llamadas.sesiones.length = 0;
    const sesiones = await get('/api/sessions?q=x', TOKEN);
    expect(sesiones.status).toBe(200);
    expect(llamadas.sesiones).toEqual(['x']);
    await expect(sesiones.json()).resolves.toMatchObject({
      sessions: [{ id: 's-1', title: 'x' }],
    });

    llamadas.memoria.length = 0;
    const memoria = await get('/api/memory?scope=proyectos', TOKEN);
    expect(memoria.status).toBe(200);
    expect(llamadas.memoria).toEqual(['proyectos']);
  });

  it('responde 404 a rutas desconocidas y 405 a métodos no GET', async () => {
    const desconocida = await get('/api/desconocida', TOKEN);
    expect(desconocida.status).toBe(404);
    await expect(desconocida.json()).resolves.toMatchObject({ error: 'No encontrado' });

    const pagina = await get('/no-existe');
    expect(pagina.status).toBe(404);

    const post = await fetch(urlFor('/api/status'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET');
  });

  it('sirve un manifest JSON válido y el service worker', async () => {
    const res = await get('/manifest.webmanifest');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/manifest+json');
    const manifest = (await res.json()) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      name: 'Asistenta',
      start_url: '/',
      display: 'standalone',
    });

    const sw = await get('/sw.js');
    expect(sw.status).toBe(200);
    const codigo = await sw.text();
    expect(codigo).toContain("'/api/'");
    expect(codigo).toContain("'/manifest.webmanifest'");
  });

  it('close deja de aceptar conexiones', async () => {
    const local = await startWebUi(deps);
    const antes = await fetch(`${local.url}/`);
    expect(antes.status).toBe(200);
    await local.close();
    await expect(fetch(`${local.url}/`)).rejects.toThrow();
  });

  it('POST /api/approvals/:id responde 404 si la aprobación ya no está pendiente', async () => {
    const post = (id: string, body: unknown, token?: string) =>
      fetch(urlFor(`/api/approvals/${id}`), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
    expect((await post('vivo', { decision: 'once' })).status).toBe(401);
    const gone = await post('caducada', { decision: 'always' }, TOKEN);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: 'La aprobación ya no está pendiente' });
    const ok = await post('vivo', { decision: 'deny' }, TOKEN);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect((await post('vivo', { decision: 'siempre-por-favor' }, TOKEN)).status).toBe(400);
  });
});
