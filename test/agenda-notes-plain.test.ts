import { describe, expect, it } from 'vitest';
import { buildAgenda } from '../src/agenda/unified.js';

// /agenda notes are read by the owner: no raw driver error in them.
describe('agenda notes in plain Spanish', () => {
  it('a raw mail or tasks error becomes a plain line', async () => {
    const agenda = await buildAgenda({
      calendar: async () => [],
      mail: async () => {
        throw new Error('imap timeout: ETIMEDOUT 10.0.0.1:993');
      },
      followups: () => {
        throw new Error('SQLITE_BUSY: database is locked');
      },
      days: 7,
    });
    const text = agenda.notes.join(' ');
    expect(agenda.notes).toContain('No se ha podido leer el correo ahora mismo.');
    expect(agenda.notes).toContain('No se ha podido leer los pendientes ahora mismo.');
    expect(text).not.toMatch(/imap|ETIMEDOUT|SQLITE|locked|993/);
  });

  it('keeps a calendar line that is already plain', async () => {
    const plain = 'No se ha podido leer el calendario: no hay conexión o no responde.';
    const agenda = await buildAgenda({
      calendar: async () => {
        throw new Error(plain);
      },
      days: 7,
    });
    expect(agenda.notes).toEqual([plain]);
  });
});
