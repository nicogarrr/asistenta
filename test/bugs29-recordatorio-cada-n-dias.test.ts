import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cadenciaDeRutina } from '../src/cron/cadencia.js';
import { Store } from '../src/db.js';
import { createReminderTool, formatReminderRows } from '../src/tools/reminder.js';

// bugs29: «recuérdame cada 2 días a las 9 regar las plantas» se guardaba con el cron del
// modelo («0 9 */2 * *»: el 31 y el 1 suenan seguidos, y en meses impares se descuadra) o
// no se programaba. Ahora va con el cron de cada día y la cadencia en el nombre, como las
// rutinas de /cron (RoutineRunner se salta los huecos de en medio).
describe('recordatorios «cada 2 días» / «cada dos semanas» (bugs29)', () => {
  const saved = { tz: process.env.TZ, pa: process.env.PA_TIMEZONE };
  const NOW = new Date('2026-11-05T09:00:00Z');
  let dir: string;
  let store: Store;
  beforeEach(() => {
    process.env.TZ = 'UTC';
    process.env.PA_TIMEZONE = 'Europe/Madrid';
    dir = mkdtempSync(join(tmpdir(), 'b29cad-'));
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
  const tool = () =>
    createReminderTool({
      store,
      scopeOf: () => 'tg:1:2',
      sync: () => {},
      now: () => NOW.getTime(),
    });
  const text = (res: { content: { type: string; text?: string }[] }): string => {
    const first = res.content[0];
    return first && first.type === 'text' ? (first.text ?? '') : '';
  };

  it('«cada 2 días a las 9»: cron diario + cadencia, aunque el modelo mande */2', async () => {
    const res = await tool().execute('id', {
      action: 'create',
      text: 'regar las plantas',
      schedule: '0 9 */2 * *',
      said: 'recuérdame cada 2 días a las 9 regar las plantas',
    } as never);
    const out = text(res as never);
    expect(out).toContain('cada 2 días a las 09:00');
    const [r] = store.listRoutines();
    expect(r?.schedule).toBe('0 9 * * *');
    expect(r && cadenciaDeRutina(r)).toEqual({ n: 2, unidad: 'dia' });
    expect(formatReminderRows([{ routine: r as never, next: null } as never], NOW)).toContain(
      'cada 2 días a las 09:00',
    );
  });

  it('«cada dos semanas el lunes a las 8», sin cron del modelo', async () => {
    const res = await tool().execute('id', {
      action: 'create',
      text: 'sacar la basura de papel',
      said: 'cada dos semanas el lunes a las 8 recuérdame sacar la basura de papel',
    } as never);
    const out = text(res as never);
    expect(out).toContain('cada 2 semanas, el lunes a las 08:00');
    const [r] = store.listRoutines();
    expect(r?.schedule).toBe('0 8 * * 1');
    expect(r && cadenciaDeRutina(r)).toEqual({ n: 2, unidad: 'semana' });
  });

  it('lo de siempre no cambia: «cada lunes a las 9»', async () => {
    await tool().execute('id', {
      action: 'create',
      text: 'llamar a mamá',
      schedule: '0 9 * * 1',
      said: 'recuérdame cada lunes a las 9 llamar a mamá',
    } as never);
    const [r] = store.listRoutines();
    expect(r?.schedule).toBe('0 9 * * 1');
    expect(r && cadenciaDeRutina(r)).toBeNull();
  });
});
