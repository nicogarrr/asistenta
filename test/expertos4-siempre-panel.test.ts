import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ONCE_ONLY_MESSAGE, startWebUi } from '../src/webui/server.js';

/**
 * «Siempre» o «Por ahora» sobre la pregunta de un especialista (asis-expertos-4).
 * Esas preguntas solo admiten «una vez» o «denegar»; el panel ya esconde los otros
 * botones, pero si llegaban (un panel abierto antes de actualizar, una llamada a mano)
 * la respuesta era 404 «La aprobación ya no está pendiente», que es falso: sigue
 * pendiente. Ahora es 409 y dice qué vale; la aprobación sigue esperando.
 */
const TOKEN = 'token-de-prueba-456';
const decididas: Array<[string, string]> = [];
const pendientes = [
  { id: 'esp-1', tool: 'delegate', onceOnly: true },
  { id: 'normal-1', tool: 'shell' },
];

let ui: Awaited<ReturnType<typeof startWebUi>>;

beforeAll(async () => {
  ui = await startWebUi({
    token: TOKEN,
    status: () => ({ ok: true }),
    sessions: () => ({ sessions: [] }),
    memory: () => ({ items: [] }),
    auditVerify: async () => ({ ok: true }),
    approvals: () => pendientes,
    approve: async (id, decision) => {
      const item = pendientes.find((p) => p.id === id);
      if (!item) return false;
      if (item.onceOnly && decision !== 'once' && decision !== 'deny') return false;
      decididas.push([id, decision]);
      return true;
    },
  });
});

afterAll(async () => {
  await ui.close();
});

async function post(id: string, decision: string): Promise<Response> {
  return fetch(new URL(`/api/approvals/${id}`, ui.url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ decision }),
  });
}

describe('panel: «Siempre» sobre la pregunta de un especialista', () => {
  it.each(['always', 'session'])('%s → 409 con el motivo, sin decidir nada', async (decision) => {
    const res = await post('esp-1', decision);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: ONCE_ONLY_MESSAGE });
    expect(decididas).toEqual([]);
  });

  it('«una vez» sobre la misma sigue funcionando', async () => {
    const res = await post('esp-1', 'once');
    expect(res.status).toBe(200);
    expect(decididas).toEqual([['esp-1', 'once']]);
  });

  it('una aprobación normal acepta «Siempre» como antes', async () => {
    expect((await post('normal-1', 'always')).status).toBe(200);
  });

  it('una que no existe sigue siendo 404', async () => {
    const res = await post('no-existe', 'always');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'La aprobación ya no está pendiente' });
  });

  it('el motivo es corto y en castellano', () => {
    expect(ONCE_ONLY_MESSAGE).toContain('una vez');
    expect(ONCE_ONLY_MESSAGE.length).toBeLessThan(140);
  });
});
