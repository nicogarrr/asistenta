import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Skill } from '../src/skills/types.js';
import { SkillUsage, USO_VENTANA_MS, usoPanel } from '../src/uso-funciones.js';
import { renderPage } from '../src/webui/page.js';
import { startWebUi, type WebUiDeps } from '../src/webui/server.js';

const NOW = Date.UTC(2026, 10, 5, 12, 0);
const DIA = 24 * 3_600_000;

function skill(id: string, over: Partial<Skill> = {}): Skill {
  return {
    id,
    name: id.replace(/-/g, ' '),
    description: '',
    body: '',
    trust: 'learned',
    createdAt: NOW - 60 * DIA,
    updatedAt: NOW - 60 * DIA,
    ...over,
  } as Skill;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('panel: «Lo que más usas» (uso de funciones y habilidades)', () => {
  it('usoPanel ordena lo más usado, oculta lo interno y lista las habilidades sin usar', () => {
    const tools = new Map([
      ['reminder', { n: 30, last: NOW - DIA }],
      ['weather', { n: 12, last: NOW - 2 * DIA }],
      ['interna', { n: 99, last: NOW - DIA }],
    ]);
    const texts: Record<string, string> = {
      reminder: 'te pongo recordatorios',
      weather: 'el tiempo de hoy',
    };
    const d = usoPanel({
      tools,
      toolText: (t) => texts[t] ?? null,
      skills: [
        skill('pedir-cita'),
        skill('renovar-dni'),
        skill('oficial', { trust: 'official' }),
        skill('apagada', { disabled: true }),
      ],
      skillUse: { 'pedir-cita': { n: 3, last: NOW - DIA } },
      now: NOW,
    });
    expect(d.dias).toBe(USO_VENTANA_MS / DIA);
    expect(d.masUsadas).toEqual([
      { texto: 'te pongo recordatorios', veces: 30 },
      { texto: 'el tiempo de hoy', veces: 12 },
    ]);
    expect(d.habilidades.total).toBe(2);
    expect(d.habilidades.masUsadas).toEqual([{ nombre: 'pedir cita', veces: 3 }]);
    expect(d.habilidades.sinUsar).toEqual(['renovar dni']);
    expect(d.archivar).toBe('/funciones archivar');
  });

  it('sin habilidades ni usos: listas vacías y sin pista de archivar', () => {
    const d = usoPanel({
      tools: new Map(),
      toolText: () => null,
      skills: [],
      skillUse: {},
      now: NOW,
    });
    expect(d.masUsadas).toEqual([]);
    expect(d.habilidades).toEqual({ total: 0, masUsadas: [], sinUsar: [] });
    expect(d.archivar).toBeNull();
  });

  it('los usos guardados en disco llegan al panel', () => {
    const dir = mkdtempSync(join(tmpdir(), 'valor6-uso-'));
    dirs.push(dir);
    const u = new SkillUsage(join(dir, '.uso.json'));
    u.record('pedir-cita', NOW - DIA);
    u.record('pedir-cita', NOW - DIA);
    const d = usoPanel({
      tools: new Map(),
      toolText: () => null,
      skills: [skill('pedir-cita')],
      skillUse: u.all(),
      now: NOW,
    });
    expect(d.habilidades.masUsadas).toEqual([{ nombre: 'pedir cita', veces: 2 }]);
  });

  const base: WebUiDeps = {
    token: 'test-only',
    status: () => ({}),
    sessions: () => [],
    memory: () => [],
    auditVerify: () => ({}),
  };
  const headers = { Authorization: 'Bearer test-only' };

  it('GET /api/uso pide token, 503 sin datos, solo GET', async () => {
    const sin = await startWebUi(base);
    try {
      expect((await fetch(`${sin.url}/api/uso`, { headers })).status).toBe(503);
    } finally {
      await sin.close();
    }
    const datos = usoPanel({
      tools: new Map(),
      toolText: () => null,
      skills: [],
      skillUse: {},
      now: NOW,
    });
    const ui = await startWebUi({ ...base, uso: () => datos });
    try {
      expect((await fetch(`${ui.url}/api/uso`)).status).toBe(401);
      expect((await fetch(`${ui.url}/api/uso`, { method: 'POST', headers })).status).toBe(405);
      const ok = await fetch(`${ui.url}/api/uso`, { headers });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual(datos);
    } finally {
      await ui.close();
    }
  });

  it('la tarjeta Funciones pinta «Lo que más usas» con textContent', () => {
    const html = renderPage();
    expect(html).toContain("pedir('/api/uso')");
    expect(html).toContain('Lo que más usas');
    expect(html).toContain('Sin usar en');
    expect(html).not.toMatch(/<script[^>]+src=/);
  });
});
