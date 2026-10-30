import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWebUi } from '../src/webui/server.js';

const TOKEN = 'token-img-1';
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
let reply: { text: string; images?: unknown } = { text: 'ok' };
let ui: Awaited<ReturnType<typeof startWebUi>>;

beforeAll(async () => {
  ui = await startWebUi({
    token: TOKEN,
    status: () => ({ ok: true }),
    sessions: () => [],
    memory: () => [],
    auditVerify: () => ({ ok: true }),
    chat: async () => reply as { text: string; images?: string[] },
  });
});
afterAll(async () => ui.close());

async function chat(): Promise<Record<string, unknown>> {
  const res = await fetch(new URL('/api/chat', ui.url), {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'haz una captura' }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe('/api/chat devuelve las capturas del turno del panel', () => {
  it('pasa las imágenes data: PNG/JPEG junto al texto', async () => {
    reply = { text: 'Aquí está', images: [PNG] };
    expect(await chat()).toEqual({ text: 'Aquí está', images: [PNG] });
  });
  it('sin imágenes, la respuesta es la de siempre', async () => {
    reply = { text: 'hola' };
    expect(await chat()).toEqual({ text: 'hola' });
  });
  it('descarta lo que no es una imagen data: (enlaces, svg, html)', async () => {
    reply = {
      text: 'x',
      images: [
        'https://evil.example/a.png',
        'data:image/svg+xml;base64,PHN2Zz4=',
        'data:text/html,hi',
        7,
      ],
    };
    expect(await chat()).toEqual({ text: 'x' });
  });
});
