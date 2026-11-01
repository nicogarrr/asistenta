import { describe, expect, it, vi } from 'vitest';
import { loadCalendar } from '../src/agenda/ics.js';
import { log } from '../src/log.js';
import { createCalendarTool } from '../src/tools/calendar.js';

// The model repeats tool text to the owner: a calendar failure must reach it as a
// plain Spanish line, with the raw error (and never the secret address) only in the log.
const SECRET_URL = 'https://calendar.google.com/calendar/ical/x/private-SUPERSECRET/basic.ics';
const ENGLISH = /Could not|calendar feed|socket hang up|ECONNRESET|answered/;

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a failure');
}

describe('calendar errors in plain Spanish', () => {
  it('a network failure gives the model a plain line, raw only to the log', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const tool = createCalendarTool({
      fetchText: async () => {
        throw new Error(`read ECONNRESET socket hang up ${SECRET_URL}`);
      },
      getUrl: async () => SECRET_URL,
    });
    const error = await failure(tool.execute('c1', { action: 'agenda' }));
    expect(error.message).toBe(
      'No he podido leer el calendario remoto: no hay conexión o no responde. Prueba más tarde.',
    );
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('ECONNRESET');
    expect(logged).not.toContain('SUPERSECRET');
    warn.mockRestore();
  });

  it('a 503 says the server is failing, in Spanish', async () => {
    const tool = createCalendarTool({
      fetchText: async () => {
        throw new Error('503 Service Unavailable');
      },
      getUrl: async () => SECRET_URL,
    });
    const error = await failure(tool.execute('c2', { action: 'agenda' }));
    expect(error.message).toMatch(/servidor falla ahora mismo \(503\)/);
    expect(error.message).not.toMatch(ENGLISH);
  });

  it('a feed failure next to a working local calendar is a Spanish warning', async () => {
    const tool = createCalendarTool({
      readLocal: async () => 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
      fetchText: async () => {
        throw new Error('socket hang up');
      },
      getUrl: async () => SECRET_URL,
    });
    const result = await tool.execute('c3', { action: 'agenda' });
    const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
    expect(text).toContain('No he podido leer el calendario remoto');
    expect(text).not.toMatch(ENGLISH);
  });

  it('/agenda gets a plain reason, not the raw error', async () => {
    const snapshot = await loadCalendar({
      fetchText: async () => {
        throw new Error(`getaddrinfo ENOTFOUND calendar.google.com ${SECRET_URL}`);
      },
      getUrl: async () => SECRET_URL,
    });
    expect(snapshot.reason).toBe(
      'No se ha podido leer el calendario: no hay conexión o no responde.',
    );
  });
});
