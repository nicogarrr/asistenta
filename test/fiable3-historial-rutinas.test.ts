import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCronCommand } from '../src/daemon/cron-command.js';
import { createRoutineFire } from '../src/daemon/routine-fire.js';
import type { Routine, Store } from '../src/db.js';
import { HISTORY_PER_ROUTINE, RoutineHistory, routineHistoryAt } from '../src/routine-history.js';
import { panelRoutines } from '../src/webui/next-up.js';

// Grok Bot enseña el «run history» de cada rutina. Asistenta solo guardaba lastRunAt:
// de «el informe de ayer no llegó» no había forma de saber si falló, si no había red
// o si Telegram no lo aceptó sin abrir el log.
const routine = (over: Partial<Routine> = {}): Routine => ({
  id: 'r1',
  scope: 'telegram:dm:42#main',
  name: 'informe',
  kind: 'schedule',
  params: null,
  steps: null,
  prompt: 'resume el correo',
  schedule: '0 8 * * *',
  enabled: true,
  createdAt: '2026-10-30T08:00:00.000Z',
  updatedAt: '2026-10-30T08:00:00.000Z',
  lastRunAt: null,
  ...over,
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmpState(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pa-historial-'));
  dirs.push(dir);
  return dir;
}

function fireDeps(
  history: RoutineHistory,
  opts: { body?: () => Promise<string>; sendOk?: () => boolean },
) {
  return {
    store: {} as Store,
    tickGoal: vi.fn(async () => {}),
    runTask: vi.fn(opts.body ?? (async () => '3 correos nuevos')),
    send: vi.fn(async () => {
      if (opts.sendOk && !opts.sendOk()) throw new Error('Network request for sendMessage failed!');
      return {};
    }),
    delivery: {
      get: () => ({ target: 'chat' as const, soloSiCambia: false }),
      commit: vi.fn(),
    } as never,
    outputDir: '/nonexistent/salidas',
    sync: vi.fn(),
    droppedRemindersPath: '/nonexistent/dropped.jsonl',
    later: () => ({ cancel: () => {} }),
    outageDelaysMs: [],
    history,
  };
}

describe('historial de ejecuciones de cada rutina', () => {
  it('cada disparo queda apuntado: bien/falló, adónde fue y un trozo de la salida', async () => {
    const history = routineHistoryAt(tmpState());
    const r = routine();
    await createRoutineFire(fireDeps(history, {}))('meta', { scope: r.scope, routine: r });
    await createRoutineFire(
      fireDeps(history, {
        body: async () => {
          throw new Error('la herramienta de correo no respondió');
        },
      }),
    )('meta', { scope: r.scope, routine: r });
    await createRoutineFire(fireDeps(history, { sendOk: () => false }))('meta', {
      scope: r.scope,
      routine: r,
    });
    const runs = history.list(r.scope, r.name);
    expect(runs.map((x) => [x.ok, x.entrega])).toEqual([
      [true, 'pendiente'],
      [false, 'chat'],
      [true, 'chat'],
    ]);
    expect(runs[2]?.salida).toBe('3 correos nuevos');
  });

  it('guarda como mucho 10 por rutina y recorta la salida', () => {
    const history = routineHistoryAt(tmpState());
    for (let i = 0; i < 15; i++) {
      history.record('s', 'r', {
        at: i,
        ok: true,
        ms: 1,
        entrega: 'chat',
        salida: 'x'.repeat(1000),
      });
    }
    const runs = history.list('s', 'r');
    expect(runs).toHaveLength(HISTORY_PER_ROUTINE);
    expect(runs[0]?.at).toBe(14);
    expect(Array.from(runs[0]?.salida ?? '').length).toBeLessThanOrEqual(300);
  });

  it('«/cron historial informe» lo enseña en el chat; la lista marca la que falló', () => {
    const state = tmpState();
    const history = routineHistoryAt(state);
    const r = routine();
    history.record(r.scope, r.name, {
      at: Date.parse('2026-11-04T07:00:00Z'),
      ok: true,
      ms: 12_000,
      entrega: 'chat',
      salida: '3 correos nuevos',
    });
    history.record(r.scope, r.name, {
      at: Date.parse('2026-11-05T07:00:00Z'),
      ok: false,
      ms: 400,
      entrega: 'reintento',
      salida: 'Sin conexión con el modelo; reintento en 1 min.',
    });
    const store = {
      listRoutines: () => [r],
      getRoutine: (scope: string, name: string) =>
        scope === r.scope && name === r.name ? r : null,
    } as unknown as Store;
    const deps = {
      store,
      routineRunner: { status: () => [] } as never,
      threadKey: r.scope,
      chatKey: 'telegram:dm:42',
      history,
    };
    const out = runCronCommand(deps, 'historial informe');
    expect(out).toContain('Últimas ejecuciones de "informe" (2, 1 con fallo)');
    expect(out).toMatch(
      /❌ jue 05\/11 08:00 · menos de 1 s · sin conexión con el modelo, se reintenta/,
    );
    expect(out).toMatch(/✅ mié 04\/11 08:00 · 12 s · enviada — 3 correos nuevos/);
    // Una sola rutina: «/cron historial» a secas ya sabe cuál.
    expect(runCronCommand(deps, 'historial')).toBe(out);
    expect(runCronCommand(deps, '')).toContain('❌ la última falló');

    const panel = panelRoutines(
      [r],
      [],
      () => '',
      '42',
      new Date(),
      (s, n) => history.list(s, n),
    );
    expect(panel[0]?.ejecuciones?.map((e) => [e.ok, e.entrega])).toEqual([
      [false, 'sin conexión, se reintenta'],
      [true, 'enviada'],
    ]);
  });

  it('un fichero roto no tumba la rutina', () => {
    // Su carpeta es un fichero: no se puede escribir ahí.
    const dir = tmpState();
    writeFileSync(join(dir, 'f'), '');
    const history = new RoutineHistory(join(dir, 'f', 'rutinas-historial.json'));
    expect(() =>
      history.record('s', 'r', { at: 1, ok: true, ms: 1, entrega: 'chat', salida: '' }),
    ).not.toThrow();
    expect(history.list('s', 'r')).toEqual([]);
  });
});
