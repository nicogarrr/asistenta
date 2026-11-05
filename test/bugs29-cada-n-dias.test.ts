import { afterEach, describe, expect, it, vi } from 'vitest';
import { cadenciaDe, cadenciaDeRutina, programadaRutinaEs } from '../src/cron/cadencia.js';
import { parseCronAdd } from '../src/cron/scheduler.js';
import type { Routine, Store } from '../src/db.js';
import { RoutineRunner, validateSchedule } from '../src/routines.js';

// bugs29: «cada 2 días a las 9 riega» o «cada 2 semanas el lunes a las 9 la basura» se
// quedaban en «No entiendo ese horario» (un cron no lo dice). Ahora se guardan con el cron
// de cada día / cada lunes y RoutineRunner se salta los huecos que llegan antes de tiempo.

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
    createdAt: '2026-11-01T09:00:00.000Z',
    updatedAt: '2026-11-01T09:00:00.000Z',
    lastRunAt: null,
  };
}

const add = (text: string) => parseCronAdd(text, validateSchedule);

afterEach(() => {
  vi.useRealTimers();
});

describe('rutinas «cada 2 días» y «cada 2 semanas» (bugs29)', () => {
  it('/cron add las entiende en vez de «No entiendo ese horario»', () => {
    expect(add('cada 2 días a las 9 riega las plantas')).toMatchObject({
      ok: true,
      schedule: '0 9 * * *',
      prompt: 'cada 2 días a las 9 riega las plantas',
    });
    expect(add('cada dos semanas el lunes a las 9 saca el reciclaje')).toMatchObject({
      ok: true,
      schedule: '0 9 * * 1',
    });
    expect(add('cada quince días el viernes a las 10 mira la nómina')).toMatchObject({
      ok: true,
      schedule: '0 10 * * 5',
    });
    expect(add('día sí, día no a las 20:30 sal a correr')).toMatchObject({
      ok: true,
      schedule: '30 20 * * *',
    });
  });

  it('lo que la cadencia no puede decir bien sigue preguntando', () => {
    // Dos tomas al día: la segunda caería «antes de tiempo».
    expect(add('cada 2 días a las 9 y a las 21 pastilla').ok).toBe(false);
    // Varios días de la semana cada dos semanas.
    expect(add('cada 2 semanas de lunes a viernes a las 9 informe').ok).toBe(false);
    expect(add('cada 2 meses a las 9 revisa el filtro').ok).toBe(false);
  });

  it('el horario se dice con su cadencia', () => {
    const r = routine('riego', 'cada 2 días a las 9 riega las plantas', '0 9 * * *');
    expect(programadaRutinaEs(r)).toBe('programada: cada 2 días a las 09:00');
    const b = routine(
      'reciclaje',
      'cada dos semanas el lunes a las 9 saca el reciclaje',
      '0 9 * * 1',
    );
    expect(programadaRutinaEs(b)).toBe('programada: cada 2 semanas, el lunes a las 09:00');
    // Una rutina normal no cambia; ni una que menciona la cadencia con otro horario.
    expect(programadaRutinaEs(routine('x', 'cada día a las 9 riega', '0 9 * * *'))).toBe(
      'programada: cada día a las 09:00',
    );
    expect(
      cadenciaDeRutina(routine('y', 'cada 2 días a las 9 y a las 21 pastilla', '0 9,21 * * *')),
    ).toBeNull();
    expect(cadenciaDe('cada 2 horas bebe agua')).toBeNull();
  });

  it('«cada 2 días» suena un día sí y otro no, también tras reiniciar', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-02T08:59:00+01:00') });
    const riego = routine('riego', 'cada 2 días a las 9 riega las plantas', '0 9 * * *');
    const store = fakeStore([riego]);
    const ran: string[] = [];
    const run = async () => {
      ran.push(new Date().toISOString().slice(0, 10));
    };
    let runner = new RoutineRunner({ store, run, catchUp: true });
    runner.start();
    try {
      await vi.advanceTimersByTimeAsync(2 * 60_000); // lun 2, 9:01
      expect(ran).toEqual(['2026-11-02']);
      // «Próxima ejecución» no es mañana.
      expect(runner.status()[0]?.next?.slice(0, 10)).toBe('2026-11-04');
      await vi.advanceTimersByTimeAsync(24 * 3_600_000); // mar 3
      expect(ran).toEqual(['2026-11-02']);
    } finally {
      runner.stop();
    }
    // Reinicio del daemon: lo que manda es la última vez guardada, no la memoria.
    runner = new RoutineRunner({ store, run, catchUp: true });
    runner.start();
    try {
      await vi.advanceTimersByTimeAsync(3 * 3_600_000); // mar 3, 12:01: sin recuperar nada
      expect(ran).toEqual(['2026-11-02']);
      await vi.advanceTimersByTimeAsync(21 * 3_600_000); // mié 4, 9:01
      await vi.advanceTimersByTimeAsync(48 * 3_600_000); // vie 6, 9:01
      expect(ran).toEqual(['2026-11-02', '2026-11-04', '2026-11-06']);
    } finally {
      runner.stop();
    }
  });

  it('«cada 2 semanas el lunes» se salta el lunes de en medio', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-02T08:59:00+01:00') });
    const basura = routine(
      'reciclaje',
      'cada 2 semanas el lunes a las 9 saca el reciclaje',
      '0 9 * * 1',
    );
    const ran: string[] = [];
    const runner = new RoutineRunner({
      store: fakeStore([basura]),
      run: async () => {
        ran.push(new Date().toISOString().slice(0, 10));
      },
    });
    runner.start();
    try {
      await vi.advanceTimersByTimeAsync(29 * 24 * 3_600_000);
      expect(ran).toEqual(['2026-11-02', '2026-11-16', '2026-11-30']);
    } finally {
      runner.stop();
    }
  });
});
