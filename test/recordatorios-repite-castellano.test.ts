import { describe, expect, it } from 'vitest';
import { scheduleEs } from '../src/cron/describe-es.js';
import type { Routine } from '../src/db.js';
import { formatReminderRows } from '../src/tools/reminder.js';

// gertru-gaps-6: /recordatorios decía «se repite (30 8 * * 1)», en jerga de cron.
describe('recordatorios que se repiten, dichos en castellano', () => {
  it('traduce los horarios de siempre', () => {
    expect(scheduleEs('30 8 * * 1')).toBe('cada lunes a las 08:30');
    expect(scheduleEs('0 9 * * *')).toBe('cada día a las 09:00');
    expect(scheduleEs('0 7 * * 1-5')).toBe('de lunes a viernes a las 07:00');
    expect(scheduleEs('0 10 * * 6,0')).toBe('los fines de semana a las 10:00');
    expect(scheduleEs('0 20 * * 1,3')).toBe('los lunes y miércoles a las 20:00');
    expect(scheduleEs('0 9 1 * *')).toBe('cada mes el día 1 a las 09:00');
    expect(scheduleEs('0 9 25 12 *')).toBe('cada año el 25/12 a las 09:00');
    expect(scheduleEs('0 */2 * * *')).toBe('cada 2 horas');
    expect(scheduleEs('*/15 * * * *')).toBe('cada 15 min');
    expect(scheduleEs('0 0 * * 0')).toBe('cada domingo a las 00:00');
    expect(scheduleEs('0 9 1-7 * 1')).toBeNull();
  });

  it('/recordatorios ya no enseña el cron', () => {
    const r = {
      scope: 's',
      name: 'recordatorio:revisar',
      kind: 'schedule',
      prompt: 'Revisar los correos',
      schedule: '30 8 * * 1',
    } as unknown as Routine;
    const text = formatReminderRows(
      [{ routine: r, next: new Date(2026, 10, 2, 8, 30) }],
      new Date(2026, 9, 31, 12, 0),
    );
    expect(text).toContain('· cada lunes a las 08:30');
    expect(text).not.toContain('* *');
  });
});
