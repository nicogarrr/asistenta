import { describe, expect, it } from 'vitest';
import { extractCommitments } from '../src/agenda/extract.js';
import { buildAgenda, formatAgenda } from '../src/agenda/unified.js';

const TZ = 'Europe/Madrid';
const NOW = Date.parse('2026-11-02T09:00:00Z');
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;

// asis-bugs-18: los títulos de la agenda se cortaban a 90 unidades UTF-16 a ciegas; un
// emoji justo en el corte («🎂», «🩺») quedaba partido y Telegram enseñaba «�».
describe('agenda: títulos largos sin medio emoji', () => {
  it('un evento del calendario con emoji en el carácter 90', async () => {
    const agenda = await buildAgenda({
      calendar: async () => [
        {
          start: Date.parse('2026-11-02T11:00:00Z'),
          end: Date.parse('2026-11-02T12:00:00Z'),
          allDay: false,
          title: `${'a'.repeat(89)}🎂 cumple`,
        } as never,
      ],
      now: () => NOW,
      timeZone: TZ,
    });
    const text = formatAgenda(agenda, { timeZone: TZ });
    expect(text).toContain('a'.repeat(89));
    expect(text).not.toMatch(LONE);
  });

  it('un compromiso sacado del correo con emoji en el carácter 90 del asunto', () => {
    const found = extractCommitments(
      [
        {
          id: 'm1',
          from: 'citas@clinica.es',
          subject: `${'b'.repeat(89)}🩺 revisión`,
          text: 'Tienes cita con el médico el 20-11 a las 9:30',
        } as never,
      ],
      { now: NOW, timeZone: TZ, minConfidence: 0 },
    );
    expect(found.length).toBeGreaterThan(0);
    for (const c of found) {
      expect(c.subject).toContain('b'.repeat(89));
      expect(c.subject).not.toMatch(LONE);
    }
  });
});
