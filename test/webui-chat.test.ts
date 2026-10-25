import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWebUi, type WebUiDeps } from '../src/webui/server.js';

const TOKEN = 'token-chat-123';
const chatCalls: string[] = [];
const aprobaciones: Array<{ id: string; decision: string }> = [];

const deps: WebUiDeps = {
  token: TOKEN,
  status: () => ({ ok: true }),
  sessions: () => [],
  memory: () => [],
  auditVerify: () => ({ ok: true }),
  chat: async (text) => {
    chatCalls.push(text);
    return { text: `eco: ${text}` };
  },
  approvals: () => [{ id: 'a-1', title: 'Enviar un correo' }],
  approve: async (id, decision) => {
    aprobaciones.push({ id, decision });
  },
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

async function postJson(
  path: string,
  body: unknown,
  token: string | null = TOKEN,
): Promise<Response> {
  return fetch(urlFor(path), {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function postRaw(
  path: string,
  body: string,
  token: string | null = TOKEN,
): Promise<Response> {
  return fetch(urlFor(path), {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
    },
    body,
  });
}

describe('chat del panel', () => {
  it('exige Bearer', async () => {
    const res = await postJson('/api/chat', { text: 'hola' }, null);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('rechaza cuerpo sin texto, vacio o que no es JSON', async () => {
    const sinTexto = await postJson('/api/chat', {});
    expect(sinTexto.status).toBe(400);

    const vacio = await postJson('/api/chat', { text: '   ' });
    expect(vacio.status).toBe(400);

    const noTexto = await postJson('/api/chat', { text: 42 });
    expect(noTexto.status).toBe(400);

    const roto = await postRaw('/api/chat', '{oops');
    expect(roto.status).toBe(400);

    const vacioTotal = await postRaw('/api/chat', '');
    expect(vacioTotal.status).toBe(400);
  });

  it('devuelve la respuesta del chat', async () => {
    chatCalls.length = 0;
    const res = await postJson('/api/chat', { text: 'hola mundo' });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ text: 'eco: hola mundo' });
    expect(chatCalls).toEqual(['hola mundo']);
  });

  it('responde 503 si no hay dependencia de chat', async () => {
    const local = await startWebUi({
      token: TOKEN,
      status: () => ({}),
      sessions: () => [],
      memory: () => [],
      auditVerify: () => ({}),
    });
    try {
      const res = await fetch(new URL('/api/chat', local.url), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: 'hola' }),
      });
      expect(res.status).toBe(503);
    } finally {
      await local.close();
    }
  });

  it('solo acepta POST', async () => {
    const res = await fetch(urlFor('/api/chat'), {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });
});

describe('aprobaciones del panel', () => {
  it('lista las pendientes con Bearer', async () => {
    const sinToken = await fetch(urlFor('/api/approvals'));
    expect(sinToken.status).toBe(401);

    const res = await fetch(urlFor('/api/approvals'), {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([{ id: 'a-1', title: 'Enviar un correo' }]);
  });

  it('valida la decision y aplica las cuatro permitidas', async () => {
    aprobaciones.length = 0;

    const sinDecision = await postJson('/api/approvals/a-1', {});
    expect(sinDecision.status).toBe(400);

    const invalida = await postJson('/api/approvals/a-1', { decision: 'quizas' });
    expect(invalida.status).toBe(400);
    expect(aprobaciones).toEqual([]);

    for (const decision of ['once', 'session', 'always', 'deny']) {
      const res = await postJson('/api/approvals/a-1', { decision });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true });
    }
    expect(aprobaciones).toEqual([
      { id: 'a-1', decision: 'once' },
      { id: 'a-1', decision: 'session' },
      { id: 'a-1', decision: 'always' },
      { id: 'a-1', decision: 'deny' },
    ]);
  });

  it('decodifica el id de la ruta', async () => {
    aprobaciones.length = 0;
    const res = await postJson('/api/approvals/a%2Fb', { decision: 'deny' });
    expect(res.status).toBe(200);
    expect(aprobaciones).toEqual([{ id: 'a/b', decision: 'deny' }]);
  });

  it('exige Bearer y solo acepta POST en la ruta con id', async () => {
    const sinToken = await postJson('/api/approvals/a-1', { decision: 'deny' }, null);
    expect(sinToken.status).toBe(401);

    const get = await fetch(urlFor('/api/approvals/a-1'), {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
  });

  it('responde 503 si no hay dependencias de aprobaciones', async () => {
    const local = await startWebUi({
      token: TOKEN,
      status: () => ({}),
      sessions: () => [],
      memory: () => [],
      auditVerify: () => ({}),
    });
    try {
      const lista = await fetch(new URL('/api/approvals', local.url), {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(lista.status).toBe(503);

      const decision = await fetch(new URL('/api/approvals/a-1', local.url), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ decision: 'deny' }),
      });
      expect(decision.status).toBe(503);
    } finally {
      await local.close();
    }
  });
});

describe('página con chat y aprobaciones', () => {
  it('incluye el formulario, el panel y llama a las rutas nuevas', async () => {
    const res = await fetch(urlFor('/'));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="form-chat"');
    expect(html).toContain('<textarea');
    expect(html).toContain('id="texto-chat"');
    expect(html).toContain('id="panel-chat"');
    expect(html).toContain("'/api/chat'");
    expect(html).toContain("'/api/approvals'");
    expect(html).toContain('/api/approvals/');
    expect(html).toContain('Permitir una vez');
    expect(html).toContain('Denegar');
    expect(html).toContain('Enter');
    expect(html).toContain('requestSubmit');
    // Nada de innerHTML: todo se pinta con textContent/replaceChildren.
    expect(html).not.toContain('innerHTML');
  });
});
