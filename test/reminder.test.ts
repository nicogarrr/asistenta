import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import { RoutineRunner } from '../src/routines.js';
import {
  createReminderTool,
  isOneShotReminder,
  isReminder,
  onceCron,
  parseLocalStamp,
  reminderText,
} from '../src/tools/reminder.js';

let dir = '';
let store: Store;
let syncs = 0;
// Monday 5 October 2026, 10:00 local.
const NOW = new Date(2026, 9, 5, 10, 0, 0).getTime();

function tool() {
  return createReminderTool({
    store,
    scopeOf: () => 'tg:1:2',
    sync: () => {
      syncs++;
    },
    now: () => NOW,
  });
}

async function run(args: Record<string, unknown>) {
  const res = await tool().execute('id', args as never);
  const first = res.content[0];
  return { text: first && first.type === 'text' ? first.text : '', isError: res.isError === true };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rem-'));
  store = new Store(join(dir, 'db.sqlite'));
  syncs = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('reminder tool', () => {
  it('crea un recordatorio a una hora local y lo dice con la hora exacta', async () => {
    const r = await run({ action: 'create', text: 'apagar el horno', in_minutes: 180 });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('2026-10-05 13:00');
    const [saved] = store.listRoutines('tg:1:2');
    expect(saved && isReminder(saved) && isOneShotReminder(saved)).toBe(true);
    expect(saved?.schedule).toBe('0 13 5 10 *');
    expect(saved && reminderText(saved)).toBe('apagar el horno');
    expect(syncs).toBe(1);
  });

  it('acepta at (YYYY-MM-DDTHH:MM) y rechaza fechas inexistentes o pasadas', async () => {
    expect(
      (await run({ action: 'create', text: 'dentista', at: '2026-10-06T09:00' })).isError,
    ).toBe(false);
    expect((await run({ action: 'create', text: 'x', at: '2026-02-31T09:00' })).isError).toBe(true);
    expect((await run({ action: 'create', text: 'x', at: '2026-10-05T09:00' })).isError).toBe(true);
    expect((await run({ action: 'create', text: 'x', in_minutes: 1 })).isError).toBe(true);
    expect(store.listRoutines('tg:1:2')).toHaveLength(1);
  });

  it('pide exactamente uno de at, in_minutes o schedule', async () => {
    expect((await run({ action: 'create', text: 'x' })).isError).toBe(true);
    expect(
      (await run({ action: 'create', text: 'x', in_minutes: 10, schedule: '0 8 * * 1' })).isError,
    ).toBe(true);
  });

  it('crea uno que se repite con cron y valida el horario', async () => {
    const ok = await run({ action: 'create', text: 'revisar los correos', schedule: '30 8 * * 1' });
    expect(ok.isError).toBe(false);
    const bad = await run({ action: 'create', text: 'x', schedule: 'cada lunes' });
    expect(bad.isError).toBe(true);
    const [saved] = store.listRoutines('tg:1:2');
    expect(saved && isOneShotReminder(saved)).toBe(false);
  });

  it('lista con la próxima ejecución y cancela por palabra', async () => {
    await run({ action: 'create', text: 'apagar el horno', in_minutes: 180 });
    await run({ action: 'create', text: 'llamar al dentista', at: '2026-10-06T09:00' });
    const list = await run({ action: 'list' });
    expect(list.text).toContain('apagar el horno');
    expect(list.text).toContain('llamar al dentista');
    const cancel = await run({ action: 'cancel', text: 'horno' });
    expect(cancel.text).toContain('Cancelado');
    expect(store.listRoutines('tg:1:2')).toHaveLength(1);
    expect((await run({ action: 'cancel', text: 'inexistente' })).isError).toBe(true);
  });

  it('no mezcla recordatorios de otro chat ni rutinas normales', async () => {
    store.saveRoutine({
      scope: 'tg:9:9',
      name: 'recordatorio-1: ajeno',
      kind: 'schedule',
      prompt: 'ajeno',
      schedule: '0 8 * * *',
    });
    store.saveRoutine({
      scope: 'tg:1:2',
      name: 'resumen',
      kind: 'schedule',
      prompt: 'resumen',
      schedule: '0 8 * * *',
    });
    expect((await run({ action: 'list' })).text).toBe('No hay recordatorios programados.');
    expect((await run({ action: 'cancel', text: 'resumen' })).isError).toBe(true);
  });

  it('parseLocalStamp y onceCron son coherentes', () => {
    const d = parseLocalStamp('2026-12-24T21:05');
    expect(d && onceCron(d)).toBe('5 21 24 12 *');
    expect(parseLocalStamp('mañana')).toBeNull();
  });

  it('el planificador real registra el recordatorio puntual a su hora', async () => {
    const fired: string[] = [];
    const runner = new RoutineRunner({
      store,
      run: async (prompt) => {
        fired.push(prompt);
      },
      now: () => new Date(NOW),
    });
    await run({ action: 'create', text: 'apagar el horno', in_minutes: 180 });
    runner.start();
    const live = runner.status().find((s) => s.name.startsWith('recordatorio-1:'));
    expect(live?.next).toBeTruthy();
    expect(new Date(live?.next ?? '').getHours()).toBe(13);
    runner.stop();
  });
});
