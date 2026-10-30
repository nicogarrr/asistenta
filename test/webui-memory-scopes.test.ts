import { describe, expect, it } from 'vitest';
import { etiquetaAmbito } from '../src/webui/client-format.js';
import { renderPage } from '../src/webui/page.js';
import { startWebUi } from '../src/webui/server.js';

describe('panel: selector de ámbito de memoria', () => {
  it('nombra los ámbitos en español', () => {
    expect(etiquetaAmbito('local')).toBe('Local (este PC)');
    expect(etiquetaAmbito('')).toBe('Local (este PC)');
    expect(etiquetaAmbito('telegram:dm:123')).toBe('Telegram privado 123');
    expect(etiquetaAmbito('telegram:dm:123#main')).toBe('Telegram privado 123 · hilo main');
    expect(etiquetaAmbito('telegram:group:-100')).toBe('Telegram grupo -100');
    expect(etiquetaAmbito('otro')).toBe('otro');
  });

  it('GET /api/memory/scopes devuelve la lista y 503 si falta la dependencia', async () => {
    const base = {
      token: 't',
      status: () => ({}),
      sessions: () => [],
      memory: () => [],
      auditVerify: () => ({}),
    };
    const con = await startWebUi({ ...base, memoryScopes: () => ['local', 'telegram:dm:1'] });
    const sin = await startWebUi(base);
    try {
      const ok = await fetch(new URL('/api/memory/scopes', con.url), {
        headers: { Authorization: 'Bearer t' },
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual(['local', 'telegram:dm:1']);
      const anon = await fetch(new URL('/api/memory/scopes', con.url));
      expect(anon.status).toBe(401);
      const falta = await fetch(new URL('/api/memory/scopes', sin.url), {
        headers: { Authorization: 'Bearer t' },
      });
      expect(falta.status).toBe(503);
    } finally {
      await con.close();
      await sin.close();
    }
  });

  it('la página usa una lista, no un campo libre', () => {
    const html = renderPage();
    expect(html).toContain('<select id="ambito-memoria">');
    expect(html).not.toContain('placeholder="local"');
    expect(html).toContain("pedir('/api/memory/scopes')");
  });
});
