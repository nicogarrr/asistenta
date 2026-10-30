import { describe, expect, it } from 'vitest';
import { COMMAND_PROMPT_PREFIX } from '../src/command-routine.js';
import { GOAL_ROUTINE_PREFIX } from '../src/goals/runner.js';
import { REMINDER_PREFIX } from '../src/tools/reminder.js';
import { formatearCampo } from '../src/webui/client-format.js';
import { type PanelRoutineSource, panelRoutines } from '../src/webui/next-up.js';
import { renderPage } from '../src/webui/page.js';
import { startWebUi, type WebUiDeps } from '../src/webui/server.js';

const now = new Date('2026-10-30T10:00:00Z');
const en = (min: number) => new Date(now.getTime() + min * 60_000).toISOString();
const PRIV = 'telegram:dm:42#main';
const fila = (o: Partial<PanelRoutineSource> & { name: string }): PanelRoutineSource => ({
  scope: PRIV,
  kind: 'schedule',
  schedule: '0 8 * * *',
  enabled: true,
  prompt: 'resume el día',
  ...o,
});

describe('panel: tarjeta Rutinas (solo lectura)', () => {
  it('lista las rutinas del dueño ordenadas por próxima ejecución, con marca de comando', () => {
    const rutinas = [
      fila({ name: 'resumen' }),
      fila({ name: 'backup', prompt: `${COMMAND_PROMPT_PREFIX}backup`, schedule: '0 3 * * *' }),
      fila({ name: 'pausada', enabled: false }),
      fila({ name: 'sin-proxima' }),
      fila({ name: 'ajena', scope: 'telegram:dm:7#main' }),
      fila({ name: 'grupo', scope: 'telegram:group:42#main' }),
      fila({ name: `${REMINDER_PREFIX}pastilla` }),
      fila({ name: `${GOAL_ROUTINE_PREFIX}x` }),
      fila({ name: 'procedimiento', kind: 'procedure', schedule: null }),
    ];
    const vivas = [
      { scope: PRIV, name: 'resumen', next: en(600) },
      { scope: PRIV, name: 'backup', next: en(120) },
      { scope: PRIV, name: 'sin-proxima', next: null },
      { scope: 'telegram:dm:7#main', name: 'ajena', next: en(5) },
    ];
    const r = panelRoutines(rutinas, vivas, () => ' ⚙️ comando: pa backup', '42', now);
    expect(r.map((x) => x.nombre)).toEqual(['backup', 'resumen', 'sin-proxima', 'pausada']);
    expect(r[0]).toMatchObject({
      comando: 'comando: pa backup',
      horario: '0 3 * * *',
      activa: true,
    });
    expect(r[0]?.proxima).toMatch(/\(en 2 h\)$/);
    expect(r[1]?.comando).toBeNull();
    expect(r[2]?.proxima).toBe('Sin próxima ejecución');
    expect(r[3]).toMatchObject({ proxima: 'Pausada', activa: false });
  });

  it('sin dueño configurado solo enseña lo local', () => {
    const r = panelRoutines(
      [fila({ name: 'priv' }), fila({ name: 'loc', scope: 'local' })],
      [],
      () => '',
      undefined,
      now,
    );
    expect(r.map((x) => x.nombre)).toEqual(['loc']);
  });

  it('GET /api/routines: 503 sin dependencia o antes de arrancar, luego la lista; pide token', async () => {
    let lista: unknown = null;
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
      expect((await fetch(`${sin.url}/api/routines`, { headers })).status).toBe(503);
    } finally {
      await sin.close();
    }
    const ui = await startWebUi({ ...base, routines: () => lista });
    try {
      expect((await fetch(`${ui.url}/api/routines`)).status).toBe(401);
      const early = await fetch(`${ui.url}/api/routines`, { headers });
      expect(early.status).toBe(503);
      expect(await early.json()).toEqual({ error: 'Rutinas aún no disponibles' });
      lista = [{ nombre: 'resumen' }];
      const ok = await fetch(`${ui.url}/api/routines`, { headers });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual([{ nombre: 'resumen' }]);
    } finally {
      await ui.close();
    }
  });

  it('la página tiene la tarjeta Rutinas y la carga al refrescar', () => {
    const html = renderPage();
    expect(html).toContain('id="panel-rutinas"');
    expect(html).toContain('data-refrescar="rutinas"');
    expect(html).toContain("pedir('/api/routines')");
    expect(html).toMatch(/rutinas: cargarRutinas/);
  });
});

describe('panel: Estado dice «Ninguno» cuando no hay nada por delante', () => {
  it('próximo recordatorio/rutina en null se leen «Ninguno», no «Sin datos»', () => {
    expect(formatearCampo('proximoRecordatorio', null)).toBe('Ninguno');
    expect(formatearCampo('proximaRutina', null)).toBe('Ninguno');
    expect(formatearCampo('proximaRutina', 'backup — mañana')).toBeNull();
    expect(formatearCampo('model', null)).toBeNull();
  });
});
