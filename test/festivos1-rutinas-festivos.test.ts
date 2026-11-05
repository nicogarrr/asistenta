import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseNatural } from '../src/cron/scheduler.js';
import type { Routine, Store } from '../src/db.js';
import { createHolidayCheck, nacionalesSinRed, skipsHolidays } from '../src/festivos-rutinas.js';
import { RoutineRunner } from '../src/routines.js';

// Martes 8 de diciembre de 2026: la Inmaculada, festivo nacional. El 9 es un miércoles normal.
const HOLIDAY = '2026-12-08';

function fakeStore(routines: Routine[]): Store {
  return {
    listRoutines: () => routines,
    getRoutine: (scope: string, name: string) =>
      routines.find((r) => r.scope === scope && r.name === name) ?? null,
    markRoutineRun: (scope: string, name: string) => {
      const hit = routines.find((r) => r.scope === scope && r.name === name);
      if (hit) hit.lastRunAt = new Date().toISOString();
    },
  } as unknown as Store;
}

function routine(name: string, prompt: string, schedule: string): Routine {
  return {
    id: name,
    scope: 'chat',
    name,
    kind: 'schedule',
    params: null,
    steps: null,
    prompt,
    schedule,
    enabled: true,
    createdAt: '2026-12-01T09:00:00.000Z',
    updatedAt: '2026-12-01T09:00:00.000Z',
    lastRunAt: null,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('«excepto festivos» se salta los festivos de verdad (festivos1)', () => {
  it('una rutina de lunes a viernes no suena en festivo, no se recupera y suena el día siguiente normal', async () => {
    vi.useFakeTimers({ now: new Date('2026-12-08T07:59:00+01:00') });
    const text = 'de lunes a viernes a las 8 abre la persiana excepto festivos';
    const parsed = parseNatural(text);
    expect(parsed?.schedule).toBe('0 8 * * 1-5');
    const persiana = routine('persiana', parsed?.prompt ?? '', parsed?.schedule ?? '');
    const normal = routine('correo', 'de lunes a viernes a las 8 revisa el correo', '0 8 * * 1-5');
    const ran: string[] = [];
    const asked: string[] = [];
    const runner = new RoutineRunner({
      store: fakeStore([persiana, normal]),
      run: async (_prompt, ctx) => {
        ran.push(`${ctx.routine.name}@${new Date().toISOString().slice(0, 10)}`);
      },
      catchUp: true,
      isHoliday: async (day) => {
        asked.push(day);
        return day === HOLIDAY;
      },
    });
    runner.start();
    try {
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      // La normal suena en festivo (no dice nada de festivos); la «excepto festivos», no.
      expect(ran).toEqual(['correo@2026-12-08']);
      // Solo se pregunta por los días de la «excepto festivos» (también los próximos, para
      // que «Próxima ejecución» se salte los festivos), y cada día una vez.
      expect(asked).toContain(HOLIDAY);
      expect(new Set(asked).size).toBe(asked.length);
      // Ni la recuperación de huecos perdidos la hace sonar más tarde ese día.
      await vi.advanceTimersByTimeAsync(4 * 3_600_000);
      expect(ran).toEqual(['correo@2026-12-08']);
      // El miércoles 9, día normal, suenan las dos a su hora.
      await vi.advanceTimersByTimeAsync(20 * 3_600_000);
      expect(ran.sort()).toEqual(['correo@2026-12-08', 'correo@2026-12-09', 'persiana@2026-12-09']);
    } finally {
      runner.stop();
    }
  });

  it('«hazlo ahora» en festivo sí la ejecuta: lo pide el dueño', async () => {
    const persiana = routine('persiana', 'cada día a las 8 riega excepto festivos', '0 8 * * *');
    const ran: string[] = [];
    const runner = new RoutineRunner({
      store: fakeStore([persiana]),
      run: async (_p, ctx) => {
        ran.push(ctx.routine.name);
      },
      isHoliday: async () => true,
    });
    expect(await runner.fire('chat', 'persiana')).toBe(true);
    expect(ran).toEqual(['persiana']);
  });

  it('reconoce la coletilla y no la confunde con la tarea', () => {
    expect(skipsHolidays('cada lunes a las 9 excepto festivos')).toBe(true);
    expect(skipsHolidays('cada día a las 9, que no sea festivo')).toBe(true);
    expect(skipsHolidays('cada día a las 9 revisa el calendario de festivos')).toBe(false);
  });
});

describe('qué días cuentan como festivo (festivos1)', () => {
  const nager = [
    { date: '2026-12-08', localName: 'Inmaculada Concepción', global: true, counties: null },
    { date: '2026-09-08', localName: 'Día de Asturias', global: false, counties: ['ES-AS'] },
    { date: '2026-09-11', localName: 'Diada', global: false, counties: ['ES-CT'] },
  ];
  const ok = (body: unknown) =>
    vi.fn(
      async () => new Response(JSON.stringify(body), { status: 200 }),
    ) as unknown as typeof fetch;

  it('nacionales y de la comunidad configurada; los de otra comunidad y un día normal, no', async () => {
    const check = createHolidayCheck({
      fetchFn: ok(nager),
      env: { PA_FESTIVOS_COMUNIDAD: 'ES-AS' },
    });
    expect(await check('2026-12-08')).toBe(true);
    expect(await check('2026-09-08')).toBe(true);
    expect(await check('2026-09-11')).toBe(false);
    expect(await check('2026-12-09')).toBe(false);
  });

  it('comunidad desconocida: solo nacionales; y suma las fiestas locales', async () => {
    const check = createHolidayCheck({
      fetchFn: ok(nager),
      env: { PA_FESTIVOS_COMUNIDAD: 'XX', PA_FESTIVOS_LOCALES: '06-29=San Pedro' },
    });
    expect(await check('2026-09-08')).toBe(false);
    expect(await check('2026-12-08')).toBe(true);
    expect(await check('2026-06-29')).toBe(true);
  });

  it('sin servicio: los nacionales que se saben sin red, y un día normal sigue siendo normal', async () => {
    const down = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const check = createHolidayCheck({ fetchFn: down, env: {} });
    expect(await check('2026-12-25')).toBe(true);
    expect(await check('2026-04-03')).toBe(true); // Viernes Santo 2026
    expect(await check('2026-12-09')).toBe(false);
    expect(nacionalesSinRed(2027)).toContain('2027-03-26'); // Viernes Santo 2027
  });
});
