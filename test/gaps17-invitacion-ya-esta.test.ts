import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SCOPES, GOOGLE_KEYS, GOOGLE_SCOPES } from '../src/google/oauth.js';
import { eventoDeInvitacion, resetWorkspaceForTests } from '../src/google/workspace.js';
import { type InvitacionCorreo, invitacionesDe } from '../src/mail/invitacion-aviso.js';
import { decidirConGoogle, textoYaEnCalendario } from '../src/mail/invitacion-google.js';

const ALL = DEFAULT_SCOPES.join(' ');
function vault(scopes = ALL, connected = true) {
  const m = new Map<string, string>([
    [GOOGLE_KEYS.clientId, 'cid.apps.googleusercontent.com'],
    [GOOGLE_KEYS.clientSecret, 'sec'],
    [GOOGLE_KEYS.scopes, scopes],
  ]);
  if (connected) m.set(GOOGLE_KEYS.refreshToken, 'RT');
  return {
    get: async (k: string) => m.get(k),
    set: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => m.delete(k),
  };
}
type Call = { method: string; url: string };
function fake(route: (u: URL) => { status: number; json?: unknown }) {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const c = { method: init?.method ?? 'GET', url: String(url) };
    if (c.url.includes('oauth2.googleapis.com/token'))
      return new Response(JSON.stringify({ access_token: 'AT', expires_in: 3600 }), {
        status: 200,
      });
    calls.push(c);
    const r = route(new URL(c.url));
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status });
  }) as typeof fetch;
  return { f, calls };
}
const TZ = () => 'Europe/Madrid';
const deps = (f: typeof fetch, scopes = ALL, connected = true) => ({
  vault: vault(scopes, connected),
  fetch: f,
  timeZone: TZ,
});
// Lo que Gmail añade solo: mismo iCalUID que el .ics, hora en UTC.
const GMAIL_EV = {
  id: 'gmail123',
  iCalUID: 'abc-123@fondo.example',
  status: 'confirmed',
  summary: 'Comité de inversión',
  start: { dateTime: '2026-11-20T08:30:00Z' },
  end: { dateTime: '2026-11-20T09:30:00Z' },
  location: 'Teams',
};

beforeEach(() => resetWorkspaceForTests());

describe('gaps-17: ¿la invitación ya está en su Google Calendar? (Gmail la añade solo)', () => {
  it('por el UID del .ics (iCalUID), a su hora local', async () => {
    const { f, calls } = fake((u) => ({
      status: 200,
      json: { items: u.searchParams.get('iCalUID') === 'abc-123@fondo.example' ? [GMAIL_EV] : [] },
    }));
    const ev = await eventoDeInvitacion(deps(f), {
      uid: 'abc-123@fondo.example',
      titulo: 'Comité de inversión',
      inicio: '2026-11-20T09:30',
    });
    expect(ev).toEqual({
      id: 'gmail123',
      titulo: 'Comité de inversión',
      inicio: '2026-11-20T09:30',
      fin: '2026-11-20T10:30',
      lugar: 'Teams',
    });
    // Solo lee: un GET, nunca escribe.
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('sin UID (o UID que no está): el mismo título a la misma hora, sin mirar tildes ni mayúsculas', async () => {
    const { f, calls } = fake((u) => ({
      status: 200,
      json: {
        items: u.searchParams.get('q')
          ? [
              {
                ...GMAIL_EV,
                id: 'otro',
                summary: 'Comité de inversión',
                start: { dateTime: '2026-11-20T10:00:00Z' },
              },
              { ...GMAIL_EV, id: 'manual', summary: 'COMITE DE INVERSION' },
            ]
          : [],
      },
    }));
    const ev = await eventoDeInvitacion(deps(f), {
      uid: 'no-esta@x',
      titulo: 'Comité de inversión',
      inicio: '2026-11-20T09:30',
    });
    expect(ev).toMatchObject({ id: 'manual', inicio: '2026-11-20T09:30' });
    expect(calls).toHaveLength(2);
    // Otro título a esa hora no cuenta.
    expect(
      await eventoDeInvitacion(deps(f), { titulo: 'Junta general', inicio: '2026-11-20T09:30' }),
    ).toBeNull();
  });

  it('un evento cancelado en Google no cuenta como «ya está»', async () => {
    const { f } = fake(() => ({
      status: 200,
      json: { items: [{ ...GMAIL_EV, status: 'cancelled' }] },
    }));
    expect(
      await eventoDeInvitacion(deps(f), {
        uid: 'abc-123@fondo.example',
        titulo: 'Comité de inversión',
        inicio: '2026-11-20T09:30',
      }),
    ).toBeNull();
  });

  it('sin Google, sin permiso de leer o con Google caído: «sin-acceso» (y no se llama a Calendar)', async () => {
    const q = { uid: 'abc-123@fondo.example', titulo: 'Comité', inicio: '2026-11-20T09:30' };
    const a = fake(() => ({ status: 200, json: { items: [GMAIL_EV] } }));
    expect(await eventoDeInvitacion(deps(a.f, ALL, false), q)).toBe('sin-acceso');
    expect(await eventoDeInvitacion(deps(a.f, GOOGLE_SCOPES.drive.join(' ')), q)).toBe(
      'sin-acceso',
    );
    expect(a.calls).toEqual([]);
    const b = fake(() => ({ status: 500 }));
    expect(await eventoDeInvitacion(deps(b.f), q)).toBe('sin-acceso');
    // Con solo el permiso de leer el calendario basta.
    const c = fake(() => ({ status: 200, json: { items: [GMAIL_EV] } }));
    expect(await eventoDeInvitacion(deps(c.f, GOOGLE_SCOPES.calendar.join(' ')), q)).toMatchObject({
      id: 'gmail123',
    });
  });
});

const ics = [
  'BEGIN:VCALENDAR',
  'METHOD:REQUEST',
  'BEGIN:VEVENT',
  'UID:abc-123@fondo.example',
  'DTSTART;TZID=Europe/Madrid:20261120T093000',
  'DTEND;TZID=Europe/Madrid:20261120T103000',
  'SUMMARY:Comité de inversión',
  'LOCATION:Teams',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');
const inv = (): InvitacionCorreo => {
  const [i] = invitacionesDe(
    [ics],
    { from: 'ana@fondo.example', subject: 'Invitación: Comité' },
    'Europe/Madrid',
    new Date('2026-11-11T18:00:00Z'),
  );
  if (!i) throw new Error('sin invitación');
  return i;
};
const EV = {
  id: 'g1',
  titulo: 'Comité de inversión',
  inicio: '2026-11-20T09:30',
  fin: '2026-11-20T10:30',
};

describe('gaps-17: la tarjeta dice «ya está» en vez de ofrecer «✅ Sí, apúntala»', () => {
  it('decide: ya está, a otra hora, o como antes', () => {
    const i = inv();
    expect(decidirConGoogle(i, null, EV)).toEqual({ kind: 'ya', ev: EV });
    expect(decidirConGoogle(i, null, { ...EV, inicio: '2026-11-19T16:00' }).kind).toBe('otra-hora');
    expect(decidirConGoogle(i, null, null).kind).toBe('normal');
    expect(decidirConGoogle(i, null, 'sin-acceso').kind).toBe('normal');
    // Un cambio o una cancelación de algo que apuntó Asistenta sigue con su botón.
    expect(decidirConGoogle(i, { ...i, gid: 'x', apuntada: true }, EV).kind).toBe('normal');
    expect(decidirConGoogle({ ...i, cancela: true }, null, EV).kind).toBe('normal');
  });

  it('textos', () => {
    const i = inv();
    const ya = textoYaEnCalendario(i, { kind: 'ya', ev: EV });
    expect(ya).toContain('ana@fondo.example');
    expect(ya).toContain('«Comité de inversión»');
    expect(ya).toContain('✅ Ya está en tu Google Calendar');
    expect(ya).not.toContain('¿La apunto');
    const otra = textoYaEnCalendario(i, {
      kind: 'otra-hora',
      ev: { ...EV, inicio: '2026-11-19T16:00', fin: '2026-11-19T17:00' },
    });
    expect(otra).toContain('pero para el jueves 19 nov, 16:00–17:00');
    expect(otra).toContain('No creo otra');
  });

  it('el daemon mira Google antes de mandar la tarjeta, y entonces va sin botones', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const i = cli.indexOf('const avisarInvitacionesCorreo = async');
    const cuerpo = cli.slice(i, i + 3000);
    expect(cuerpo).toMatch(
      /eventoDeInvitacion\([\s\S]*?textoYaEnCalendario\(inv, conGoogle\),\n\s*\}\);\n\s*continue;/,
    );
    expect(cuerpo.indexOf('textoYaEnCalendario')).toBeLessThan(cuerpo.indexOf("'✅ Sí, apúntala'"));
  });
});
