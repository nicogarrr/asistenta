// Memoria: la opción sin ámbito dice qué ámbito lee (#555 + sugerencia de mem5).
import { describe, expect, it } from 'vitest';
import { etiquetaAmbitoPorDefecto } from '../src/webui/client-format.js';
import { renderPage } from '../src/webui/page.js';
import { startWebUi, type WebUiDeps } from '../src/webui/server.js';

const base: WebUiDeps = {
  token: 't',
  status: () => ({}),
  sessions: () => [],
  memory: () => [],
  auditVerify: () => ({}),
  memoryScopes: () => ['local', 'telegram:dm:42#main', 'telegram:dm:42#viaje'],
};
const headers = { Authorization: 'Bearer t' };

describe('panel: Memoria marca el ámbito por defecto', () => {
  it('la primera opción dice qué se lee sin elegir ámbito (no siempre «Local»)', () => {
    expect(etiquetaAmbitoPorDefecto('telegram:dm:42#main')).toBe(
      'Por defecto · Telegram privado 42 · hilo main',
    );
    expect(etiquetaAmbitoPorDefecto('local')).toBe('Por defecto · Local (este PC)');
    expect(etiquetaAmbitoPorDefecto('')).toBe('Por defecto · Local (este PC)');
  });

  it('/api/memory/scopes añade porDefecto cuando el daemon lo sabe; sin él, la lista de siempre', async () => {
    const con = await startWebUi({ ...base, memoryDefaultScope: () => 'telegram:dm:42#main' });
    const sin = await startWebUi(base);
    try {
      const a = await fetch(`${con.url}/api/memory/scopes`, { headers });
      expect(await a.json()).toEqual({
        ambitos: ['local', 'telegram:dm:42#main', 'telegram:dm:42#viaje'],
        porDefecto: 'telegram:dm:42#main',
      });
      const b = await fetch(`${sin.url}/api/memory/scopes`, { headers });
      expect(await b.json()).toEqual(['local', 'telegram:dm:42#main', 'telegram:dm:42#viaje']);
    } finally {
      await con.close();
      await sin.close();
    }
  });

  it('la página entiende las dos formas y no repite el ámbito por defecto', () => {
    const html = renderPage();
    expect(html).not.toContain('<option value="">Local (este PC)</option>');
    expect(html).toContain('formato.etiquetaAmbitoPorDefecto(porDefecto)');
    expect(html).toContain('ambito === porDefecto');
    expect(html).toContain('var etiquetaAmbitoPorDefecto = ');
  });
});
