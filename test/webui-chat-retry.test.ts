import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/webui/page.js';
import { startWebUi, type WebUiDeps } from '../src/webui/server.js';

const base: WebUiDeps = {
  token: 'test-only',
  status: () => ({}),
  sessions: () => [],
  memory: () => [],
  auditVerify: () => ({}),
};
const headers = { Authorization: 'Bearer test-only', 'Content-Type': 'application/json' };
const post = (url: string, h: Record<string, string> = headers) =>
  fetch(`${url}/api/chat/retry`, { method: 'POST', headers: h, body: '{}' });

describe('panel: «Reintentar» repite el último turno (POST /api/chat/retry)', () => {
  it('503 sin dependencia; 401 sin token', async () => {
    const ui = await startWebUi(base);
    try {
      expect((await post(ui.url)).status).toBe(503);
      expect((await post(ui.url, { 'Content-Type': 'application/json' })).status).toBe(401);
    } finally {
      await ui.close();
    }
  });

  it('409 si no hay nada que repetir; si lo hay, devuelve la nueva respuesta', async () => {
    let siguiente: { text: string } | null = null;
    let llamadas = 0;
    const ui = await startWebUi({
      ...base,
      retry: async () => {
        llamadas++;
        return siguiente;
      },
    });
    try {
      const vacio = await post(ui.url);
      expect(vacio.status).toBe(409);
      expect(await vacio.json()).toEqual({ error: 'No hay un mensaje reciente que repetir' });
      siguiente = { text: 'otra respuesta' };
      const ok = await post(ui.url);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ text: 'otra respuesta' });
      expect(llamadas).toBe(2);
      expect((await fetch(`${ui.url}/api/chat/retry`, { headers })).status).not.toBe(200);
    } finally {
      await ui.close();
    }
  });

  it('el botón Reintentar de un turno fallido repite sin la respuesta anterior; sin conexión reenvía', () => {
    const html = renderPage();
    expect(html).toContain("enviar('/api/chat/retry', {})");
    expect(html).toMatch(
      /if \(error && error\.sinConexion\) enviarChat\(null, texto\);\s*else repetirUltimo\(\);/,
    );
  });

  it('cli.ts cablea retry con el rebobinado de /reintentar y sin fotos', () => {
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const i = src.indexOf('retry: async () => {');
    expect(i).toBeGreaterThan(0);
    const bloque = src.slice(i, i + 1800);
    expect(bloque).toContain('lastTurns.get(thread.key)');
    expect(bloque).toContain('last.images?.length) return null');
    expect(bloque).toContain('rewindLastTurn(last');
    expect(bloque).toContain('runPanelChat(thread, last.text');
  });
});
