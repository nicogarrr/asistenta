import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import { createReminderTool, franjaFromWords, whenFromWords } from '../src/tools/reminder.js';

const TZ = 'Europe/Madrid';
const wall = (d: Date | null): string | null =>
  d
    ? new Intl.DateTimeFormat('sv-SE', {
        timeZone: TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(d)
    : null;

let prevTz: string | undefined;
beforeEach(() => {
  prevTz = process.env.PA_TIMEZONE;
  process.env.PA_TIMEZONE = TZ;
});
afterEach(() => {
  if (prevTz === undefined) delete process.env.PA_TIMEZONE;
  else process.env.PA_TIMEZONE = prevTz;
});

// Jueves 5 de noviembre de 2026, 10:00 en Madrid.
const NOW = new Date('2026-11-05T09:00:00Z');

describe('horas exactas dichas de palabra', () => {
  it.each([
    ['en un cuarto de hora', '2026-11-05 10:15'],
    ['dentro de un cuarto de hora', '2026-11-05 10:15'],
    ['en tres cuartos de hora', '2026-11-05 10:45'],
    ['en hora y media', '2026-11-05 11:30'],
    ['en una hora y media', '2026-11-05 11:30'],
    ['a mediodía', '2026-11-05 12:00'],
    ['al mediodia', '2026-11-05 12:00'],
    ['el sábado a mediodía', '2026-11-07 12:00'],
    ['a medianoche', '2026-11-06 00:00'],
  ])('«%s» → %s', (said, want) => {
    expect(wall(whenFromWords(said, NOW, TZ))).toBe(want);
  });

  it('«a mediodía» pasado el mediodía es mañana', () => {
    const at13 = new Date('2026-11-05T12:00:00Z');
    expect(wall(whenFromWords('a mediodía', at13, TZ))).toBe('2026-11-06 12:00');
  });
});

describe('partes del día sin hora', () => {
  it.each([
    ['mañana por la mañana', '2026-11-06 09:00'],
    ['esta tarde', '2026-11-05 17:00'],
    ['esta noche', '2026-11-05 21:00'],
    ['el sábado por la tarde', '2026-11-07 17:00'],
    ['el lunes por la mañana', '2026-11-09 09:00'],
    ['mañana a primera hora', '2026-11-06 08:00'],
    ['mañana temprano', '2026-11-06 08:00'],
    ['por la noche', '2026-11-05 21:00'],
    ['pasado mañana por la tarde', '2026-11-07 17:00'],
  ])('«%s» → %s', (said, want) => {
    expect(wall(franjaFromWords(said, NOW, TZ)?.at ?? null)).toBe(want);
  });

  it('«por la mañana» ya pasada la franja es mañana; «esta mañana» pasada no vale', () => {
    const at14 = new Date('2026-11-05T13:00:00Z');
    expect(wall(franjaFromWords('por la mañana', at14, TZ)?.at ?? null)).toBe('2026-11-06 09:00');
    expect(franjaFromWords('esta mañana', at14, TZ)).toBeNull();
  });

  it('«esta noche» dicho a las 22:00 es dentro de una hora, no a las 21:00 que ya pasó', () => {
    const at22 = new Date('2026-11-05T21:00:00Z');
    expect(wall(franjaFromWords('esta noche', at22, TZ)?.at ?? null)).toBe('2026-11-05 23:00');
  });

  it('con hora o con más palabras no es una franja', () => {
    expect(franjaFromWords('esta tarde a las 6', NOW, TZ)).toBeNull();
    expect(franjaFromWords('esta noche llamo a Ana', NOW, TZ)).toBeNull();
  });

  it('la franja va de una hora a otra: las 16:00 del sábado caben en «por la tarde»', () => {
    const f = franjaFromWords('el sábado por la tarde', NOW, TZ);
    expect(wall(f?.from ?? null)).toBe('2026-11-07 14:00');
    expect(wall(f?.to ?? null)).toBe('2026-11-07 21:00');
  });
});

describe('el recordatorio con una franja dicha', () => {
  let dir: string;
  let store: Store;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ag3rem-'));
    store = new Store(join(dir, 'db.sqlite'));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
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

  it('la hora del modelo dentro de la franja se respeta', async () => {
    const out = await run({
      action: 'create',
      text: 'llamar a mamá',
      at: '2026-11-07T16:00',
      said: 'el sábado por la tarde',
    });
    expect(out).toBe('Recordatorio programado para 2026-11-07 16:00 (hora local): llamar a mamá.');
  });

  it('fuera de la franja (el modelo puso otro día) va a la hora de la franja y lo dice', async () => {
    const out = await run({
      action: 'create',
      text: 'llamar a mamá',
      at: '2026-11-08T10:00',
      said: 'el sábado por la tarde',
    });
    expect(out).toContain('2026-11-07 17:00');
    expect(out).toContain('por la tarde como dijiste');
  });

  it('solo con las palabras también vale', async () => {
    expect(await run({ action: 'create', text: 'sacar la basura', said: 'esta noche' })).toContain(
      '2026-11-05 21:00',
    );
    expect(await run({ action: 'create', text: 'horno', said: 'en un cuarto de hora' })).toContain(
      '2026-11-05 10:15',
    );
  });
});
