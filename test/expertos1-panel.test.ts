/**
 * Tarjeta «Apuntes» del panel: tus temas de apuntes con sus archivos, los que no se pudieron
 * leer (y por qué), las instrucciones del tema y la carpeta donde soltarlos. Antes solo se
 * veían con /expertos en Telegram.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BaseExpertos } from '../src/expertos/base.js';
import { panelApuntes } from '../src/expertos/panel.js';
import { startWebUi } from '../src/webui/server.js';

let dir: string;
let base: BaseExpertos;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'expertos1-panel-'));
  mkdirSync(join(dir, 'ex', 'derecho'), { recursive: true });
  writeFileSync(
    join(dir, 'ex', 'derecho', 'civil.md'),
    'Artículo 1555\nEl arrendatario paga el precio.',
  );
  writeFileSync(join(dir, 'ex', 'derecho', 'escaneo.jpg'), Buffer.from([0xff, 0xd8]));
  base = new BaseExpertos({ root: join(dir, 'ex'), dbPath: join(dir, 'i.sqlite'), rescanMs: 0 });
  base.fijarInstrucciones('derecho', 'cita artículos');
});
afterEach(() => {
  base.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('tarjeta Apuntes', () => {
  it('lista temas, archivos, sin leer e instrucciones', async () => {
    const p = await panelApuntes(base);
    expect(p.temas).toHaveLength(1);
    expect(p.temas[0]).toMatchObject({ nombre: 'derecho', instrucciones: 'cita artículos' });
    expect(p.temas[0]?.archivos).toEqual([
      { archivo: 'civil.md', trozos: 1, motivo: '' },
      { archivo: 'escaneo.jpg', trozos: 0, motivo: 'foto: el OCR local no está disponible' },
    ]);
  });

  it('GET /api/expertos con token, y la tarjeta en la página', async () => {
    const server = await startWebUi({
      token: 'secreto',
      status: () => ({}),
      sessions: () => [],
      memory: () => [],
      auditVerify: () => ({}),
      expertos: () => panelApuntes(base),
    });
    try {
      const url = server.url.replace(/\/$/, '');
      expect((await fetch(`${url}/api/expertos`)).status).toBe(401);
      const r = await fetch(`${url}/api/expertos`, {
        headers: { Authorization: 'Bearer secreto' },
      });
      expect(r.status).toBe(200);
      expect(((await r.json()) as { temas: { nombre: string }[] }).temas[0]?.nombre).toBe(
        'derecho',
      );
      const page = await (await fetch(`${url}/`)).text();
      expect(page).toContain('id="panel-apuntes"');
      expect(page).toContain("pedir('/api/expertos')");
    } finally {
      await server.close();
    }
  });
});
