import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { startWebUi, type WebUiDeps } from '../src/webui/server.js';

// «Reintentar» de un turno con fotos: el panel no puede repetirlo (no tiene las fotos),
// y antes decía «No hay un mensaje reciente que repetir», que era falso.
const base: WebUiDeps = {
  token: 'test-only',
  status: () => ({}),
  sessions: () => [],
  memory: () => [],
  auditVerify: () => ({}),
};
const headers = { Authorization: 'Bearer test-only', 'Content-Type': 'application/json' };
const post = (url: string) =>
  fetch(`${url}/api/chat/retry`, { method: 'POST', headers, body: '{}' });

describe('panel: «Reintentar» de un mensaje con fotos explica que se repite desde Telegram', () => {
  it('409 con un mensaje claro cuando el último mensaje llevaba fotos', async () => {
    const ui = await startWebUi({ ...base, retry: async () => 'con-fotos' as const });
    try {
      const r = await post(ui.url);
      expect(r.status).toBe(409);
      const cuerpo = (await r.json()) as { error: string };
      expect(cuerpo.error).toMatch(/fotos/);
      expect(cuerpo.error).toContain('/reintentar');
      expect(cuerpo.error).not.toMatch(/No hay un mensaje/);
    } finally {
      await ui.close();
    }
  });

  it('sin mensaje que repetir sigue siendo «No hay un mensaje reciente que repetir»', async () => {
    const ui = await startWebUi({ ...base, retry: async () => null });
    try {
      const r = await post(ui.url);
      expect(r.status).toBe(409);
      expect(await r.json()).toEqual({ error: 'No hay un mensaje reciente que repetir' });
    } finally {
      await ui.close();
    }
  });

  it('cli.ts distingue «nada que repetir» de «llevaba fotos» y sigue sin repetir fotos', () => {
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const i = src.indexOf('retry: async () => {');
    expect(i).toBeGreaterThan(0);
    const bloque = src.slice(i, i + 1800);
    expect(bloque).toContain('if (!last) return null;');
    expect(bloque).toContain("if (last.images?.length) return 'con-fotos';");
    expect(bloque.indexOf("return 'con-fotos'")).toBeLessThan(bloque.indexOf('runPanelChat('));
  });
});
