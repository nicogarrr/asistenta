import { describe, expect, it } from 'vitest';
import type { Routine } from '../src/db.js';
import { nextScheduleRun } from '../src/routines.js';
import {
  dentroDeEs,
  fechaCortaEs,
  formatReminderRows,
  pickReminder,
  reminderRows,
} from '../src/tools/reminder.js';

function routine(name: string, prompt: string | null, schedule: string | null): Routine {
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
    createdAt: '',
    updatedAt: '',
  } as Routine;
}

const NOW = new Date(2026, 9, 30, 12, 0); // vie 30-oct-2026 12:00 local
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m);

const dentista = routine('recordatorio-1:dentista', 'Llamar al dentista', '0 9 31 10 *');
const correos = routine('recordatorio:correos', 'Revisar los correos', '30 8 * * 1');
const horno = routine('recordatorio-1:horno', 'Apagar el horno', '15 12 30 10 *');
const rutina = routine('backup-nocturno', 'haz backup', '0 3 * * *');
const roto = routine('recordatorio:roto', 'Uno roto', 'no es cron');

const nexts = new Map<string, Date | null>([
  [dentista.name, at(31, 9)],
  [correos.name, new Date(2026, 10, 2, 8, 30)],
  [horno.name, at(30, 12, 15)],
  [roto.name, null],
]);
const nextOf = (r: Routine) => nexts.get(r.name) ?? null;

describe('/recordatorios', () => {
  it('lista solo recordatorios, ordenados por la próxima vez, con fecha en español', () => {
    const rows = reminderRows([dentista, correos, rutina, roto, horno], nextOf);
    expect(rows.map((r) => r.routine.name)).toEqual([
      horno.name,
      dentista.name,
      correos.name,
      roto.name,
    ]);
    const text = formatReminderRows(rows, NOW);
    expect(text).toContain('Recordatorios: 4');
    expect(text).toContain('1. Apagar el horno — vie 30/10 12:15 (en 15 min)');
    expect(text).toContain('2. Llamar al dentista — sáb 31/10 09:00 (en 21 h)');
    expect(text).toContain(
      '3. Revisar los correos — lun 02/11 08:30 (en 3 d) · se repite (30 8 * * 1)',
    );
    expect(text).toContain('4. Uno roto — sin próxima vez');
    expect(text).not.toContain('backup');
    expect(text).toContain('/recordatorios borrar');
  });

  it('sin recordatorios explica cómo crearlos', () => {
    expect(formatReminderRows(reminderRows([rutina], nextOf), NOW)).toContain(
      'No tienes recordatorios',
    );
  });

  it('borra por número o por palabra única, y nunca si hay duda', () => {
    const rows = reminderRows([dentista, correos, horno], nextOf);
    const byNumber = pickReminder(rows, '2');
    expect(byNumber.ok && byNumber.routine.name).toBe(dentista.name);
    const byWord = pickReminder(rows, 'HORNO');
    expect(byWord.ok && byWord.routine.name).toBe(horno.name);

    const ambiguous = pickReminder(rows, 'r');
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(ambiguous.error).toContain('Bórralo por número');
    const outOfRange = pickReminder(rows, '9');
    expect(outOfRange.ok).toBe(false);
    if (!outOfRange.ok) expect(outOfRange.error).toBe('No hay recordatorio 9: elige entre 1 y 3.');
    expect(pickReminder(rows, '').ok).toBe(false);
    expect(pickReminder(rows, 'zzz').ok).toBe(false);
    expect(pickReminder([], '1').ok).toBe(false);
  });

  it('formatos de fecha y plazo', () => {
    expect(fechaCortaEs(at(25, 3, 5))).toBe('dom 25/10 03:05');
    expect(dentroDeEs(30_000)).toBe('en menos de 1 min');
    expect(dentroDeEs(90 * 60_000)).toBe('en 1 h 30 min');
    expect(dentroDeEs(2 * 3_600_000)).toBe('en 2 h');
  });

  it('nextScheduleRun da la próxima vez de un cron válido y null si no lo es', () => {
    expect(nextScheduleRun('no es cron')).toBeNull();
    const next = nextScheduleRun('30 8 * * 1');
    expect(next?.getDay()).toBe(1);
    expect(next?.getHours()).toBe(8);
    expect(next?.getMinutes()).toBe(30);
  });
});
