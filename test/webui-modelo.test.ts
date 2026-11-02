// Ruta POST /api/modelo del panel: cambia el modelo desde la tarjeta Estado.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWebUi, type WebUiDeps } from '../src/webui/server.js';

const TOKEN = 'token-de-prueba-modelo';

let recibido: string | null = null;

const deps: WebUiDeps = {
  token: TOKEN,
  status: () => ({
    model: 'deepseek-v4.1-flash',
    provider: 'opencode-go',
    modelosDisponibles: [{ id: 'deepseek-v4.1-flash', nombre: 'DeepSeek V4.1 Flash', nota: 'x' }],
  }),
  sessions: () => ({ sessions: [] }),
  memory: () => ({ items: [] }),
  auditVerify: async () => ({ ok: true }),
  setClave: async (clave) => ({
    ok: true,
    mensaje: `Clave guardada (${clave.length} caracteres).`,
  }),
  setModelo: async (id) => {
    recibido = id;
    if (id === 'glm-5.3') {
      return { ok: true, mensaje: 'Listo: Asistenta usa GLM 5.3 por OpenCode Go (coste 0).' };
    }
    return { ok: false, mensaje: 'Ese modelo no está en la lista.' };
  },
};

let ui: Awaited<ReturnType<typeof startWebUi>>;

beforeAll(async () => {
  ui = await startWebUi(deps);
});

afterAll(async () => {
  await ui.close();
});

function post(body: unknown): Promise<Response> {
  return fetch(new URL('/api/modelo', ui.url).toString(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/modelo', () => {
  it('aplica un modelo válido y devuelve el mensaje para el panel', async () => {
    const res = await post({ model: 'glm-5.3' });
    expect(res.status).toBe(200);
    expect(recibido).toBe('glm-5.3');
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.mensaje).toContain('GLM 5.3');
  });

  it('rechaza un modelo fuera de la lista con el motivo', async () => {
    const res = await post({ model: 'gpt-carísimo' });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('no está en la lista');
  });

  it('pide el campo model', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('Falta el modelo');
  });

  it('requiere el token del panel', async () => {
    const res = await fetch(new URL('/api/modelo', ui.url).toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.3' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/clave', () => {
  it('guarda una clave válida y no la devuelve', async () => {
    const res = await fetch(new URL('/api/clave', ui.url).toString(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clave: 'clave-buena-1234567890' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(JSON.stringify(data)).not.toContain('clave-buena-1234567890');
  });

  it('pide el campo clave', async () => {
    const res = await fetch(new URL('/api/clave', ui.url).toString(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
