import { describe, expect, it } from 'vitest';
import { scheduledForToday } from '../src/briefing-daily.js';

// bugs29: un festivo (8 de diciembre), el resumen de la mañana anunciaba «08:30 fichar» de una
// rutina «excepto festivos», que ese día no suena. Ahora no sale; las demás siguen saliendo.
describe('resumen de la mañana en festivo (bugs29)', () => {
  const now = new Date('2026-12-08T06:00:00Z'); // 07:00 en Madrid
  const rows = [
    {
      name: 'fichar',
      prompt: 'avísame para fichar excepto festivos',
      enabled: true,
      next: '2026-12-08T07:30:00Z',
    },
    {
      name: 'recordatorio:tomar la pastilla [0 9 * * *]',
      prompt: 'tomar la pastilla',
      enabled: true,
      next: '2026-12-08T08:00:00Z',
    },
    {
      name: 'recordatorio:sacar la basura [0 21 * * 1-5] excepto festivos',
      prompt: 'sacar la basura',
      enabled: true,
      next: '2026-12-08T20:00:00Z',
    },
  ];
  it('festivo: las «excepto festivos» no se anuncian', () => {
    const out = scheduledForToday(rows, now, 'Europe/Madrid', true);
    expect(out.routines).toEqual([]);
    expect(out.reminders.map((r) => r.text)).toEqual(['tomar la pastilla']);
  });
  it('día normal: salen todas, como antes', () => {
    const out = scheduledForToday(rows, now, 'Europe/Madrid');
    expect(out.routines.map((r) => r.name)).toEqual(['fichar']);
    expect(out.reminders).toHaveLength(2);
  });
});
