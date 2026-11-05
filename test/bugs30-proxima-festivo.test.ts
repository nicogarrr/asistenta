import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Routine, Store } from '../src/db.js';
import { RoutineRunner } from '../src/routines.js';

// Lunes 7 de diciembre de 2026 por la tarde; el martes 8 (la Inmaculada) es festivo.
function fakeStore(routines: Routine[]): Store {
  return {
    listRoutines: () => routines,
    getRoutine: (scope: string, name: string) =>
      routines.find((r) => r.scope === scope && r.name === name) ?? null,
    markRoutineRun: () => {},
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

describe('«Próxima ejecución» de una rutina «excepto festivos» se salta el festivo (bugs30)', () => {
  it('/cron y el panel dicen el miércoles 9, no el martes festivo; la normal sigue el martes', async () => {
    vi.useFakeTimers({ now: new Date('2026-12-07T20:00:00+01:00') });
    const runner = new RoutineRunner({
      store: fakeStore([
        routine(
          'persiana',
          'de lunes a viernes a las 8 abre la persiana excepto festivos',
          '0 8 * * 1-5',
        ),
        routine('correo', 'de lunes a viernes a las 8 revisa el correo', '0 8 * * 1-5'),
      ]),
      run: async () => {},
      isHoliday: async (day) => day === '2026-12-08' || day === '2026-12-25',
    });
    runner.start();
    try {
      await runner.refreshHolidays();
      const next = Object.fromEntries(runner.status().map((s) => [s.name, s.next]));
      expect(next.persiana).toBe(new Date('2026-12-09T08:00:00+01:00').toISOString());
      expect(next.correo).toBe(new Date('2026-12-08T08:00:00+01:00').toISOString());
    } finally {
      runner.stop();
    }
  });

  it('festivos seguidos (puente): salta todos hasta el primer día que sí suena', async () => {
    vi.useFakeTimers({ now: new Date('2026-12-04T20:00:00+01:00') });
    const runner = new RoutineRunner({
      store: fakeStore([
        routine('fichar', 'a las 9 recuérdame fichar salvo festivos', '0 9 * * *'),
      ]),
      run: async () => {},
      isHoliday: async (day) =>
        ['2026-12-05', '2026-12-06', '2026-12-07', '2026-12-08'].includes(day),
    });
    runner.start();
    try {
      await runner.refreshHolidays();
      expect(runner.status()[0]?.next).toBe(new Date('2026-12-09T09:00:00+01:00').toISOString());
    } finally {
      runner.stop();
    }
  });

  it('si no se puede saber si es festivo, la próxima es la del horario (como al sonar)', async () => {
    vi.useFakeTimers({ now: new Date('2026-12-07T20:00:00+01:00') });
    const runner = new RoutineRunner({
      store: fakeStore([
        routine('persiana', 'a las 8 abre la persiana excepto festivos', '0 8 * * *'),
      ]),
      run: async () => {},
      isHoliday: async () => {
        throw new Error('sin red');
      },
    });
    runner.start();
    try {
      await runner.refreshHolidays();
      expect(runner.status()[0]?.next).toBe(new Date('2026-12-08T08:00:00+01:00').toISOString());
    } finally {
      runner.stop();
    }
  });
});
