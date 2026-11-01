import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadCalendar } from '../src/agenda/ics.js';
import { appendEvent } from '../src/agenda/write.js';
import { createCalendarTool } from '../src/tools/calendar.js';

vi.mock('../src/log.js', () => ({ log: { info: vi.fn(), warn: vi.fn() } }));
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});
async function localCalendar() {
  const root = await mkdtemp(join(tmpdir(), 'calendar-connection-'));
  roots.push(root);
  const file = join(root, 'local.ics');
  const start = new Date(Date.now() + 3_600_000);
  await appendEvent(file, { title: 'Cita local de prueba', start });
  return { readLocal: () => readFile(file, 'utf8'), start };
}
function textOf(result: Awaited<ReturnType<ReturnType<typeof createCalendarTool>['execute']>>) {
  return result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}
describe('local calendar write -> normal read -> proactive agenda', () => {
  it('returns a real appended event to the normal calendar tool without a remote feed', async () => {
    const local = await localCalendar();
    const result = await createCalendarTool({
      ...local,
      getUrl: async () => undefined,
      fetchText: vi.fn(),
    }).execute('read', { action: 'agenda' });
    expect(textOf(result)).toContain('Cita local de prueba');
    expect(result.details).toMatchObject({ configured: true, stale: false });
  });
  it('returns that same event to the proactive agenda, including zero-duration events', async () => {
    const local = await localCalendar();
    const result = await loadCalendar({
      ...local,
      getUrl: async () => undefined,
      fetchText: vi.fn(),
    });
    expect(result.events.map((e) => e.title)).toEqual(['Cita local de prueba']);
    expect(result.events[0]?.start).toBe(Math.floor(local.start.getTime() / 1000) * 1000);
  });
  it('preserves local events and reports remote failure without leaking the secret URL', async () => {
    const local = await localCalendar();
    const secret = 'https://example.com/SECRET/basic.ics';
    const result = await createCalendarTool({
      ...local,
      getUrl: async () => secret,
      fetchText: async () => {
        throw new Error(`socket ${secret}`);
      },
    }).execute('read', { action: 'agenda' });
    expect(textOf(result)).toContain('Cita local de prueba');
    expect(textOf(result)).toContain('No he podido leer el calendario remoto');
    expect(textOf(result)).not.toContain('socket');
    expect(textOf(result)).not.toContain(secret);
  });
  it('deduplicates an exported local event imported into the remote feed by UID and occurrence', async () => {
    const local = await localCalendar();
    const result = await loadCalendar({
      ...local,
      getUrl: async () => 'https://example.com/basic.ics',
      fetchText: local.readLocal,
    });
    expect(result.events).toHaveLength(1);
  });
});

it('missing local file preserves remote-only behavior and never exposes its path', async () => {
  const { readLocalCalendar } = await import('../src/agenda/sources.js');
  expect(
    await readLocalCalendar(join(tmpdir(), 'missing-asistenta-local-calendar', 'local.ics')),
  ).toBeUndefined();
});
it('local read failure is visible while the remote calendar remains usable', async () => {
  const local = await localCalendar();
  const result = await createCalendarTool({
    getUrl: async () => 'https://example.com/basic.ics',
    fetchText: local.readLocal,
    readLocal: async () => {
      throw new Error('/private/path/secret');
    },
  }).execute('read', { action: 'agenda' });
  expect(textOf(result)).toContain('Cita local de prueba');
  expect(textOf(result)).toContain('No se ha podido leer el calendario local');
  expect(textOf(result)).not.toContain('/private/path/secret');
  expect(result.details).toMatchObject({ degraded: true });
});
it('local events do not bypass the private URL guard', async () => {
  const local = await localCalendar();
  const fetchText = vi.fn();
  const result = await createCalendarTool({
    ...local,
    getUrl: async () => 'http://127.0.0.1/private',
    fetchText,
  }).execute('read', { action: 'agenda' });
  expect(fetchText).not.toHaveBeenCalled();
  expect(textOf(result)).toContain('Cita local de prueba');
  expect(textOf(result)).not.toContain('127.0.0.1');
  expect(result.details).toMatchObject({ degraded: true });
});
it('retains separate occurrences with a shared UID', async () => {
  const local = await localCalendar();
  const text = await local.readLocal();
  const next = text.replace(
    /DTSTART:(\d{8})T(\d{6})Z/,
    (_all, day, time) => `DTSTART:${day}T${String(Number(time) + 10000).padStart(6, '0')}Z`,
  );
  const result = await loadCalendar({
    ...local,
    getUrl: async () => 'https://example.com/basic.ics',
    fetchText: async () => next,
  });
  expect(result.events).toHaveLength(2);
});
it('wires the same state file into the tool and vigilante, and guards the writer and local tool read', async () => {
  const cli = await readFile(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const tool = cli.slice(
    cli.indexOf('      createCalendarTool({'),
    cli.indexOf('      createSystemTool()'),
  );
  expect(tool).toContain('isOwnerDm(inboundFor(thread), vigilanteOwnerId)');
  expect(tool).toContain("readLocalCalendar(join(paths.state, 'calendar', 'local.ics'))");
  const watcher = cli.slice(cli.indexOf('const calendarSnapshot = await loadCalendar({'));
  expect(watcher.split('getUrl:')[0]).toContain(
    "readLocalCalendar(join(paths.state, 'calendar', 'local.ics'))",
  );
  const writer = cli.slice(
    cli.indexOf('  const cmdCalendario = async'),
    cli.indexOf('  const cmdSkillsImport'),
  );
  expect(writer.indexOf('isOwnerDm(inbound, vigilanteOwnerId)')).toBeLessThan(
    writer.indexOf('await appendEvent'),
  );
  // La frase «calendario local (no a Google)» vive en confirmacionCalendario (bugs7 test).
  expect(writer).toContain('confirmacionCalendario(title, start, new Date())');
});
it('keeps calendar degradation observable in the proactive reader', async () => {
  const { upcomingEvents } = await import('../src/agenda/ics.js');
  const { log } = await import('../src/log.js');
  vi.mocked(log.warn).mockClear();
  const local = await localCalendar();
  const secret = 'https://example.com/SECRET/basic.ics';
  const events = await upcomingEvents({
    ...local,
    getUrl: async () => secret,
    fetchText: async () => {
      throw new Error(`socket ${secret}`);
    },
  });
  expect(events).toHaveLength(1);
  expect(log.warn).toHaveBeenCalledWith(
    'agenda: calendar unavailable',
    expect.objectContaining({ reason: expect.stringContaining('no hay conexión') }),
  );
  // The raw cause stays observable, in the log only.
  expect(log.warn).toHaveBeenCalledWith(
    'agenda: remote calendar unreachable',
    expect.objectContaining({ err: expect.stringContaining('socket') }),
  );
  expect(JSON.stringify(vi.mocked(log.warn).mock.calls)).not.toContain(secret);
});
it('wires the vigilante snapshot reason into unified agenda notes', async () => {
  const cli = await readFile(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const watcher = cli.slice(
    cli.indexOf('      agenda: async () =>'),
    cli.indexOf('      // Cargos raros:'),
  );
  expect(watcher).toContain('loadCalendar(');
  expect(watcher).toContain('calendarSnapshot.reason');
  expect(watcher).toContain('agenda.notes.push');
});
