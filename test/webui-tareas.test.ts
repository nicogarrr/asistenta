import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TaskBoard } from '../src/tasks/board.js';
import { renderPage } from '../src/webui/page.js';
import { startWebUi, type WebUiDeps } from '../src/webui/server.js';
import { panelTareas } from '../src/webui/tareas.js';

const now = () => new Date(2026, 9, 28, 9, 0); // miércoles 28-10-2026

function tablero(): TaskBoard {
  const board = new TaskBoard(join(mkdtempSync(join(tmpdir(), 'pa-tareas-')), 'tareas.json'), now);
  board.add('telegram:dm:7', 'llamar al banco', '2026-10-29', '10:00');
  board.add('telegram:dm:7#hilo', 'fontanero', '2026-10-30');
  board.add('telegram:dm:7', 'devolver libro', '2026-10-20');
  board.add('telegram:group:-5', 'cosa del grupo', '2026-10-29');
  board.add('telegram:dm:99', 'de otra persona', '2026-10-29');
  return board;
}

describe('panel: tareas de la semana (solo lectura)', () => {
  it('solo enseña lo del dueño, con día, hora y estado; atrasadas aparte', () => {
    const r = panelTareas(tablero(), 7);
    expect(r.tareas).toEqual([
      { dia: 'jueves 29', hora: '10:00', titulo: 'llamar al banco', estado: 'pendiente' },
      { dia: 'viernes 30', titulo: 'fontanero', estado: 'pendiente' },
    ]);
    expect(r.atrasadas.map((t) => t.titulo)).toEqual(['devolver libro']);
    expect(JSON.stringify(r)).not.toMatch(/grupo|otra persona|telegram|"id"/);
  });

  it('una tarea que se repite trae «cada semana» para el panel', () => {
    const board = tablero();
    board.add('telegram:dm:7', 'sacar la basura', '2026-10-31', undefined, 'semanal');
    const fila = panelTareas(board, 7).tareas.find((t) => t.titulo === 'sacar la basura');
    expect(fila).toEqual({
      dia: 'sábado 31',
      titulo: 'sacar la basura',
      estado: 'pendiente',
      repite: 'cada semana',
    });
  });

  it('sin dueño configurado no enseña chats de Telegram', () => {
    expect(panelTareas(tablero(), undefined)).toEqual({ tareas: [], atrasadas: [] });
  });

  it('GET /api/tareas pide token, 503 sin tablero, y solo admite GET', async () => {
    const base: WebUiDeps = {
      token: 'test-only',
      status: () => ({}),
      sessions: () => [],
      memory: () => [],
      auditVerify: () => ({}),
    };
    const headers = { Authorization: 'Bearer test-only' };
    const sin = await startWebUi(base);
    try {
      expect((await fetch(`${sin.url}/api/tareas`, { headers })).status).toBe(503);
    } finally {
      await sin.close();
    }
    const board = tablero();
    const ui = await startWebUi({ ...base, tareas: () => panelTareas(board, 7) });
    try {
      expect((await fetch(`${ui.url}/api/tareas`)).status).toBe(401);
      const ok = await fetch(`${ui.url}/api/tareas`, { headers });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { tareas: unknown[] }).tareas).toHaveLength(2);
      const post = await fetch(`${ui.url}/api/tareas`, { method: 'POST', headers, body: '{}' });
      expect(post.status).not.toBe(200);
      expect(board.all()).toHaveLength(5);
    } finally {
      await ui.close();
    }
  });

  it('la tarjeta es solo lectura: sin botones para borrar ni cambiar', () => {
    const html = renderPage();
    const i = html.indexOf('id="titulo-tareas"');
    expect(i).toBeGreaterThan(-1);
    const tarjeta = html.slice(i, html.indexOf('</article>', i));
    expect(tarjeta.match(/<button/g)).toHaveLength(1);
    expect(tarjeta).toContain('data-refrescar="tareas"');
    expect(html).toContain("pedir('/api/tareas')");
    expect(html).not.toMatch(/enviar\('\/api\/tareas/);
  });
});
