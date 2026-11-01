/**
 * Google Calendar en la agenda: OAuth y API con fetch falso (sin red).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadCalendarSources } from '../src/agenda/sources.js';
import { googleEventsToIcs, readGoogleCalendar } from '../src/google/calendar.js';
import { googleCommand } from '../src/google/cli.js';
import { DEFAULT_SCOPES, GOOGLE_KEYS } from '../src/google/oauth.js';
import { createCalendarTool, parseIcs } from '../src/tools/calendar.js';

function memVault(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    vault: {
      get: async (k: string) => m.get(k),
      set: async (k: string, v: string) => {
        m.set(k, v);
      },
      delete: async (k: string) => m.delete(k),
    },
  };
}

const connected = {
  [GOOGLE_KEYS.clientId]: 'cid',
  [GOOGLE_KEYS.clientSecret]: 'csecret',
  [GOOGLE_KEYS.refreshToken]: 'rtok',
  [GOOGLE_KEYS.scopes]: 'https://www.googleapis.com/auth/calendar.readonly',
};

const NOW = Date.parse('2026-11-02T08:00:00Z');

function fakeGoogle(items: unknown[], calStatus = 200) {
  const urls: string[] = [];
  const auths: (string | undefined)[] = [];
  const fn = (async (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'atok', expires_in: 3600 }));
    }
    auths.push((init?.headers as Record<string, string> | undefined)?.authorization);
    return new Response(JSON.stringify({ items }), { status: calStatus });
  }) as typeof fetch;
  return { fn, urls, auths };
}

const items = [
  {
    id: 'a1',
    summary: 'Dentista; revisión',
    location: 'C/ Mayor, 3',
    start: { dateTime: '2026-11-03T10:00:00+01:00' },
    end: { dateTime: '2026-11-03T10:30:00+01:00' },
  },
  { id: 'a2', summary: 'Puente', start: { date: '2026-11-09' }, end: { date: '2026-11-10' } },
  { id: 'a3', status: 'cancelled', summary: 'Cancelada', start: { date: '2026-11-04' } },
];

describe('Google Calendar', () => {
  it('pide solo leer el calendario (nada de escribir eventos ni leer el correo)', () => {
    expect(DEFAULT_SCOPES).toEqual(['https://www.googleapis.com/auth/calendar.readonly']);
  });

  it('convierte los eventos de Google a iCal que la agenda entiende', () => {
    const events = parseIcs(googleEventsToIcs(items), new Date(NOW));
    expect(events.map((e) => e.summary)).toEqual(['Dentista; revisión', 'Puente']);
    expect(events[0]?.start.toISOString()).toBe('2026-11-03T09:00:00.000Z');
    expect(events[0]?.location).toBe('C/ Mayor, 3');
    expect(events[1]?.allDay).toBe(true);
  });

  it('lee con el token de acceso, solo de googleapis, sin token en la salida', async () => {
    const { vault } = memVault(connected);
    const g = fakeGoogle(items);
    const ics = await readGoogleCalendar({ vault, fetch: g.fn, clock: () => NOW });
    expect(ics).toContain('SUMMARY:Dentista\\; revisión');
    expect(ics).not.toContain('atok');
    const cal = g.urls.find((u) => u.includes('/calendar/v3/'));
    expect(
      cal?.startsWith('https://www.googleapis.com/calendar/v3/calendars/primary/events?'),
    ).toBe(true);
    expect(cal).toContain('singleEvents=true');
    expect(g.auths).toEqual(['Bearer atok']);
  });

  it('sin Google conectado no hace nada (ni red)', async () => {
    const { vault } = memVault();
    const g = fakeGoogle(items);
    expect(await readGoogleCalendar({ vault, fetch: g.fn })).toBeUndefined();
    expect(g.urls).toHaveLength(0);
  });

  it('un permiso retirado se dice en castellano y la agenda sigue con lo local', async () => {
    const { vault } = memVault(connected);
    const g = fakeGoogle([], 401);
    const src = await loadCalendarSources({
      getUrl: async () => undefined,
      fetchText: async () => '',
      readLocal: async () => undefined,
      readGoogle: () => readGoogleCalendar({ vault, fetch: g.fn, clock: () => NOW }),
    });
    expect(src.google).toBeUndefined();
    expect(src.googleError).toContain('pa google conectar');
  });

  it('la herramienta calendar enseña los eventos de Google', async () => {
    const tool = createCalendarTool({
      getUrl: async () => undefined,
      fetchText: async () => '',
      readGoogle: async () =>
        googleEventsToIcs([
          {
            ...items[0],
            start: { dateTime: new Date(Date.now() + 3_600_000).toISOString() },
            end: { dateTime: new Date(Date.now() + 7_200_000).toISOString() },
          },
        ]),
    });
    const out = await tool.execute('1', { action: 'agenda', days: 2 }, undefined, undefined);
    const text = out.content.map((c) => ('text' in c ? c.text : '')).join('\n');
    expect(text).toContain('Dentista');
  });

  it('pa google estado y desconectar hablan claro', async () => {
    const lines: string[] = [];
    const { vault, m } = memVault(connected);
    const g = fakeGoogle([]);
    const deps = { vault, fetch: g.fn, print: (l: string) => lines.push(l) };
    expect(await googleCommand(['estado'], deps)).toBe(0);
    expect(lines.at(-1)).toBe('Google conectado: leo tu Calendar.');
    expect(await googleCommand(['desconectar'], deps)).toBe(0);
    expect(m.has(GOOGLE_KEYS.refreshToken)).toBe(false);
    expect(await googleCommand(['estado'], deps)).toBe(1);
    expect(lines.at(-1)).toContain('pa google conectar');
    expect(await googleCommand(['otra'], deps)).toBe(2);
    expect(lines.at(-1)).not.toMatch(/^uso:/i);
  });

  it('cli.ts conecta pa google y el calendario de Google solo en el chat privado', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli).toContain("case 'google':");
    expect(cli).toMatch(
      /readGoogle: \(\) =>\s*isOwnerDm\(inboundFor\(thread\), vigilanteOwnerId\)\s*\?\s*googleCalendarReader\(\)\(\)/,
    );
  });
});
