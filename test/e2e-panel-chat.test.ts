import { afterEach, describe, expect, it } from 'vitest';
import { type PanelChatThread, runPanelChat } from '../src/daemon/panel-chat.js';
import { panelTokenFromEnv } from '../src/panel-doctor.js';
import { startWebUi } from '../src/webui/server.js';

// Recorrido de punta a punta del panel web como lo haría un usuario nuevo de
// Windows: .env guardado con el Bloc de notas (token con «\r» final), abre el
// panel, pega el token y escribe «hola». El turno es falso (sin modelo).
const TOKEN = 'k'.repeat(32);
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function panel(runTurn: Parameters<typeof runPanelChat>[2]['runTurn']) {
  const thread: PanelChatThread = {
    key: 'panel',
    generation: 0,
    tail: Promise.resolve(),
    active: false,
  };
  const recordados: string[] = [];
  const token = panelTokenFromEnv({ PA_WEB_TOKEN: ` ${TOKEN}\r` });
  const web = await startWebUi({
    token,
    status: () => ({}),
    sessions: () => [],
    memory: () => [],
    auditVerify: () => ({}),
    chat: (text) =>
      runPanelChat(thread, text, { remember: (_t, m) => recordados.push(m), runTurn }),
  });
  close = web.close;
  return { url: web.url, recordados };
}

const post = (url: string, body: unknown, auth?: string, host?: string) =>
  fetch(`${url}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: auth } : {}),
      ...(host ? { Host: host } : {}),
    },
    body: JSON.stringify(body),
  });

describe('panel web: de abrirlo a la primera respuesta', () => {
  it('la página abre sin token incrustado y el chat responde con el token del .env recortado', async () => {
    const { url, recordados } = await panel(async (_t, text, out) => {
      out.answer(`¡Hola! Me has dicho «${text}».`);
    });
    const pagina = await fetch(url);
    expect(pagina.status).toBe(200);
    expect(pagina.headers.get('content-type')).toMatch(/text\/html/);
    expect(await pagina.text()).not.toContain(TOKEN);

    const sin = await post(url, { text: 'hola' });
    expect(sin.status).toBe(401);
    expect(await sin.json()).toEqual({ error: 'No autorizado' });
    expect((await post(url, { text: 'hola' }, `Bearer ${TOKEN}x`)).status).toBe(401);

    const ok = await post(url, { text: 'hola' }, `Bearer ${TOKEN} `);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ text: '¡Hola! Me has dicho «hola».' });
    expect(recordados).toEqual(['hola']);
  });

  it('con «localhost» en la barra también entra (mucha gente no escribe 127.0.0.1)', async () => {
    const { url } = await panel(async (_t, _x, out) => out.answer('vale'));
    const port = new URL(url).port;
    const r = await post(url, { text: 'hola' }, `Bearer ${TOKEN}`, `localhost:${port}`);
    expect(r.status).toBe(200);
  });

  it('un mensaje vacío o un fallo del turno no enseñan texto técnico', async () => {
    const { url } = await panel(async () => {
      throw new TypeError('fetch failed');
    });
    const vacio = await post(url, { text: '   ' }, `Bearer ${TOKEN}`);
    expect(vacio.status).toBe(400);
    const cuerpoVacio = JSON.stringify(await vacio.json());
    expect(cuerpoVacio).not.toMatch(/undefined|TypeError|stack/i);

    const fallo = await post(url, { text: 'hola' }, `Bearer ${TOKEN}`);
    expect(fallo.status).toBeGreaterThanOrEqual(500);
    const cuerpo = JSON.stringify(await fallo.json());
    expect(cuerpo).not.toMatch(/fetch failed|TypeError|at .*\.ts/);
  });
});
