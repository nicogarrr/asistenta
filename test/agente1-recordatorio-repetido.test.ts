import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import { createReminderTool, scheduleFromWords } from '../src/tools/reminder.js';

/**
 * Los recordatorios que se repiten iban solo con el cron que escribía el modelo, y a veces
 * fallaba («cada lunes a las 9,30» → «30 9 * * 2», o sin los minutos). Ahora `said` con las
 * palabras del dueño también vale para los repetidos: se leen con el lector de /rutina y, si
 * no cuadran con el cron, mandan las palabras.
 */
describe('recordatorio repetido: lo que dice el dueño manda sobre el cron', () => {
  const saved = { tz: process.env.TZ, pa: process.env.PA_TIMEZONE };
  const NOW = new Date('2026-11-05T09:00:00Z');
  let dir: string;
  let store: Store;
  beforeEach(() => {
    process.env.TZ = 'UTC';
    process.env.PA_TIMEZONE = 'Europe/Madrid';
    dir = mkdtempSync(join(tmpdir(), 'ag1rep-'));
    store = new Store(join(dir, 'db.sqlite'));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    if (saved.tz === undefined) delete process.env.TZ;
    else process.env.TZ = saved.tz;
    if (saved.pa === undefined) delete process.env.PA_TIMEZONE;
    else process.env.PA_TIMEZONE = saved.pa;
  });

  it('lee el horario repetido; sin «cada…» no es una rutina', () => {
    expect(scheduleFromWords('cada lunes a las 9,30')).toBe('30 9 * * 1');
    expect(scheduleFromWords('todos los días a las 22:00')).toBe('0 22 * * *');
    expect(scheduleFromWords('entre semana a las 8')).toBe('0 8 * * 1-5');
    expect(scheduleFromWords('mañana a las 9')).toBeNull();
    expect(scheduleFromWords('el viernes a las 8')).toBeNull();
    expect(scheduleFromWords('')).toBeNull();
  });

  const run = async (args: Record<string, unknown>): Promise<string> => {
    const tool = createReminderTool({
      store,
      scopeOf: () => 'tg:1:2',
      sync: () => {},
      now: () => NOW.getTime(),
    });
    const res = await tool.execute('id', args as never);
    const first = res.content[0];
    return first && first.type === 'text' ? first.text : '';
  };

  it('si el cron no cuadra con lo dicho, se usa lo dicho y se avisa', async () => {
    const out = await run({
      action: 'create',
      text: 'sacar la basura',
      schedule: '30 9 * * 2',
      said: 'cada lunes a las 9,30',
    });
    expect(out).toContain('Lo he puesto como dijiste («cada lunes a las 9,30»)');
    expect(store.listRoutines('tg:1:2')[0]?.schedule).toBe('30 9 * * 1');
  });

  it('si cuadra, igual que antes; solo con `said` también vale', async () => {
    const same = await run({
      action: 'create',
      text: 'pastilla',
      schedule: '0 22 * * *',
      said: 'todos los días a las 22:00',
    });
    expect(same).not.toContain('como dijiste');
    expect(
      await run({ action: 'create', text: 'gimnasio', said: 'entre semana a las 8' }),
    ).toContain('Recordatorio programado');
    const rows = store.listRoutines('tg:1:2').map((r) => r.schedule);
    expect(rows).toContain('0 8 * * 1-5');
  });

  it('palabras que no son un horario repetido no tocan el cron', async () => {
    await run({ action: 'create', text: 'riego', schedule: '0 20 * * 3', said: 'por la tarde' });
    expect(store.listRoutines('tg:1:2')[0]?.schedule).toBe('0 20 * * 3');
  });
});
