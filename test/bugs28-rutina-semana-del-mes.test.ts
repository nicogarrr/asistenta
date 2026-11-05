import { Cron } from 'croner';
import { describe, expect, it } from 'vitest';
import { scheduleEs } from '../src/cron/describe-es.js';
import { parseNatural } from '../src/cron/scheduler.js';
import { routineNameFromPrompt } from '../src/daemon/cron-command.js';
import { validateSchedule } from '../src/routines.js';

// bugs28: «el primer lunes de cada mes», «cada segundo martes», «el último viernes de cada
// mes» se preguntaban siempre («no entiendo ese horario»). croner los dice con «1#1», «5#L».
const at = (t: string) => parseNatural(t)?.schedule ?? null;

describe('rutinas: el primer/segundo/último día de la semana del mes', () => {
  it('se programan con la semana del mes', () => {
    expect(at('el primer lunes de cada mes a las 9 pagar alquiler')).toBe('0 9 * * 1#1');
    expect(at('cada segundo martes a las 18:30 reunión')).toBe('30 18 * * 2#2');
    expect(at('el último viernes de cada mes a las 9 nómina')).toBe('0 9 * * 5#L');
    expect(at('el tercer miércoles del mes a las 8 y a las 20 pastilla')).toBe('0 8,20 * * 3#3');
    expect(at('el cuarto domingo de cada mes a las 10 misa')).toBe('0 10 * * 0#4');
  });

  it('el horario es válido y suena el día que toca', () => {
    for (const s of ['0 9 * * 1#1', '0 9 * * 5#L']) expect(validateSchedule(s).ok, s).toBe(true);
    const runs = new Cron('0 9 * * 1#1', { paused: true, timezone: 'Europe/Madrid' })
      .nextRuns(2, new Date('2026-11-05T10:00:00Z'))
      .map((d) => d.toISOString().slice(0, 10));
    expect(runs).toEqual(['2026-12-07', '2027-01-04']);
    const last = new Cron('0 9 * * 5#L', { paused: true, timezone: 'Europe/Madrid' })
      .nextRuns(1, new Date('2026-11-05T10:00:00Z'))
      .map((d) => d.toISOString().slice(0, 10));
    expect(last).toEqual(['2026-11-27']);
  });

  it('la lista lo dice en palabras', () => {
    expect(scheduleEs('0 9 * * 1#1')).toBe('el primer lunes de cada mes a las 09:00');
    expect(scheduleEs('0 9 * * 5#L')).toBe('el último viernes de cada mes a las 09:00');
  });

  it('el nombre de la rutina no se queda con «primer»', () => {
    expect(routineNameFromPrompt('el primer lunes de cada mes a las 9 pagar alquiler')).toBe(
      'pagar-alquiler',
    );
  });

  it('sin «de cada mes» ni «cada», o con dos días, se sigue preguntando', () => {
    expect(at('el último viernes a las 18 informe')).toBeNull();
    expect(at('el primer lunes a las 9 revisar')).toBeNull();
    expect(at('el primer lunes y el tercer jueves de cada mes a las 9 x')).toBeNull();
  });
});
