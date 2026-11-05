import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/db.js';
import { RoutineRunner } from '../src/routines.js';
import { createReminderTool, liveNextOf, reminderRows } from '../src/tools/reminder.js';

// bugs30: /recordatorios y la lista del modelo calculaban «próximo» con el cron crudo: un
// recordatorio «cada 2 días» que sonó hoy decía «mañana», y uno «excepto festivos», el
// festivo. Ahora la próxima es la del planificador.
describe('/recordatorios dice la próxima vez de verdad (bugs30)', () => {
  const saved = { tz: process.env.TZ, pa: process.env.PA_TIMEZONE };
  let dir: string;
  let store: Store;
  let runner: RoutineRunner;
  beforeEach(() => {
    process.env.TZ = 'UTC';
    process.env.PA_TIMEZONE = 'Europe/Madrid';
    vi.useFakeTimers({ now: new Date('2026-11-05T10:00:00+01:00') });
    dir = mkdtempSync(join(tmpdir(), 'b30rec-'));
    store = new Store(join(dir, 'db.sqlite'));
    runner = new RoutineRunner({ store, run: async () => {}, timeoutMs: 5_000 });
  });
  afterEach(() => {
    runner.stop();
    store.close();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
    if (saved.tz === undefined) delete process.env.TZ;
    else process.env.TZ = saved.tz;
    if (saved.pa === undefined) delete process.env.PA_TIMEZONE;
    else process.env.PA_TIMEZONE = saved.pa;
  });

  it('«cada 2 días» que sonó hoy: la próxima es pasado mañana, no mañana', async () => {
    const tool = createReminderTool({
      store,
      scopeOf: () => 'tg:1:2',
      sync: () => runner.sync(),
      nextOf: liveNextOf(() => runner.status()),
    });
    await tool.execute('id', {
      action: 'create',
      text: 'regar las plantas',
      schedule: '0 9 * * *',
      said: 'recuérdame cada 2 días a las 9 regar las plantas',
    } as never);
    const [r] = store.listRoutines();
    expect(r).toBeDefined();
    store.markRoutineRun(r?.scope ?? '', r?.name ?? '');
    runner.start();
    const rows = reminderRows(
      store.listRoutines('tg:1:2'),
      liveNextOf(() => runner.status()),
    );
    expect(rows[0]?.next?.toISOString()).toBe(new Date('2026-11-07T09:00:00+01:00').toISOString());
    // Con el cron crudo era mañana.
    expect(reminderRows(store.listRoutines('tg:1:2'))[0]?.next?.toISOString()).toBe(
      new Date('2026-11-06T09:00:00+01:00').toISOString(),
    );
    const res = (await tool.execute('id', { action: 'list' } as never)) as {
      content: { text?: string }[];
    };
    expect(res.content[0]?.text).toContain('próximo: sáb 07/11');
  });

  it('sin planificador (o sin esa rutina), el cron de siempre', () => {
    const next = liveNextOf(() => [])({ scope: 's', name: 'x', schedule: '0 9 * * *' } as never);
    expect(next?.toISOString()).toBe(new Date('2026-11-06T09:00:00+01:00').toISOString());
  });
});
