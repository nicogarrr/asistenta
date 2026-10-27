/** Shared calendar inputs. Local events do not depend on a working remote feed. */
import { readFile } from 'node:fs/promises';
import type { CalendarEvent } from '../tools/calendar.js';
import { isFetchable } from '../tools/fetch.js';
import { withTimeout } from '../utils.js';

export interface CalendarSources {
  getUrl: () => Promise<string | undefined>;
  fetchText: (url: string) => Promise<string>;
  readLocal?: () => Promise<string | undefined>;
}
export async function readLocalCalendar(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('No se ha podido leer el calendario local.');
  }
}
export async function loadCalendarSources(deps: CalendarSources) {
  let local: string | undefined;
  let localError: string | undefined;
  try {
    local = await deps.readLocal?.();
  } catch {
    localError = 'No se ha podido leer el calendario local.';
  }
  let remote: string | undefined;
  let url: string | undefined;
  let remoteError: unknown;
  let invalidUrl = false;
  try {
    url = (await deps.getUrl())?.trim();
    if (url) {
      if (!isFetchable(url)) {
        invalidUrl = true;
      } else
        remote = await withTimeout(
          deps.fetchText(url),
          20_000,
          'el calendario no ha respondido en 20s',
        );
    }
  } catch (err) {
    remoteError = err;
  }
  return { local, localError, remote, url, remoteError, invalidUrl };
}
/** UID alone is not enough: recurring events share it across distinct occurrences. */
export function mergeCalendarEvents(
  local: CalendarEvent[],
  remote: CalendarEvent[],
): CalendarEvent[] {
  const merged = new Map<string, CalendarEvent>();
  for (const event of [...local, ...remote]) {
    const key = `${event.id}\u0000${event.start.getTime()}`;
    if (!merged.has(key)) merged.set(key, event);
  }
  return [...merged.values()].sort((a, b) => a.start.getTime() - b.start.getTime());
}
