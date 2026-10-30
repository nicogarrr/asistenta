import { describe, expect, it, vi } from 'vitest';
import type { AgendaEvent } from '../src/agenda/ics.js';
import { buildAgenda } from '../src/agenda/unified.js';
import type { MailMessage } from '../src/mail/types.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const TZ = 'Europe/Madrid';
/** Martes 20/10/2026, 10:00 en Madrid. */
const NOW = Date.parse('2026-10-20T08:00:00Z');
/** Jueves 22/10/2026 00:00 y 10:00 en Madrid (CEST, +02:00). */
const THU_00 = Date.parse('2026-10-21T22:00:00Z');
const THU_10 = Date.parse('2026-10-22T08:00:00Z');

const allDay = (title: string): AgendaEvent =>
  ({ id: 'ev-1', title, start: THU_00, end: THU_00 + 86_400_000, allDay: true }) as AgendaEvent;

const mail = (text: string, id = 'm1'): MailMessage => ({
  id,
  from: 'citas@clinica.test',
  to: ['yo@ejemplo.com'],
  subject: 'Cita dentista',
  text,
  at: NOW - 3_600_000,
  seen: false,
  folder: 'INBOX',
});

describe('agenda: al fusionar dos avisos de lo mismo, no se pierde la hora', () => {
  it('evento de día completo + correo con hora → sale con la hora del correo', async () => {
    const agenda = await buildAgenda({
      calendar: async () => [allDay('Cita dentista')],
      mail: async () => [mail('Te confirmamos tu cita dentista el jueves 22/10 a las 10:00.')],
      now: () => NOW,
      timeZone: TZ,
    });
    const item = agenda.upcoming.find((i) => /dentista/i.test(i.title));
    expect(agenda.upcoming.filter((i) => /dentista/i.test(i.title))).toHaveLength(1);
    expect(item?.sources).toEqual(['calendario', 'correo']);
    expect(item?.timed).toBe(true);
    expect(item?.at).toBe(THU_10);
  });

  it('un evento con hora no se mueve por un correo sin hora del mismo día', async () => {
    const timed = { ...allDay('Cita dentista'), start: THU_10, allDay: false } as AgendaEvent;
    const agenda = await buildAgenda({
      calendar: async () => [timed],
      mail: async () => [mail('Recuerda tu cita dentista el jueves 22/10.')],
      now: () => NOW,
      timeZone: TZ,
    });
    const item = agenda.upcoming.find((i) => /dentista/i.test(i.title));
    expect(item?.at).toBe(THU_10);
    expect(item?.timed).toBe(true);
  });
});
