import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SCOPES, GOOGLE_KEYS, GOOGLE_SCOPES, tienePermiso } from '../src/google/oauth.js';
import {
  buscarContacto,
  calTime,
  crearEvento,
  leerDrive,
  moverEvento,
  resetWorkspaceForTests,
} from '../src/google/workspace.js';
import { Gate, GOOGLE_READ_ACTIONS } from '../src/permissions.js';
import { googleChatCommand } from '../src/tools/google.js';

const ALL = DEFAULT_SCOPES.join(' ');
function vault(scopes = ALL, connected = true) {
  const m = new Map<string, string>([
    [GOOGLE_KEYS.clientId, 'cid.apps.googleusercontent.com'],
    [GOOGLE_KEYS.clientSecret, 'sec'],
    [GOOGLE_KEYS.scopes, scopes],
  ]);
  if (connected) m.set(GOOGLE_KEYS.refreshToken, 'RT');
  return {
    m,
    get: async (k: string) => m.get(k),
    set: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => m.delete(k),
  };
}

type Call = { method: string; url: string; body?: string };
function fake(route: (c: Call) => { status: number; json?: unknown; text?: string }) {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const c = { method: init?.method ?? 'GET', url: String(url), body: init?.body as string };
    calls.push(c);
    if (c.url.includes('oauth2.googleapis.com/token'))
      return new Response(JSON.stringify({ access_token: 'AT', expires_in: 3600 }), {
        status: 200,
      });
    const r = route(c);
    return new Response(r.status === 204 ? null : (r.text ?? JSON.stringify(r.json ?? {})), {
      status: r.status,
    });
  }) as typeof fetch;
  return { f, calls };
}
const TZ = () => 'Europe/Madrid';

beforeEach(() => resetWorkspaceForTests());

describe('Google: calendario, contactos y Drive', () => {
  it('«conectar» pide ahora calendario (escribir), contactos y Drive', () => {
    for (const s of [
      ...GOOGLE_SCOPES.calendarWrite,
      ...GOOGLE_SCOPES.contacts,
      ...GOOGLE_SCOPES.drive,
    ])
      expect(DEFAULT_SCOPES).toContain(s);
    expect(tienePermiso(GOOGLE_SCOPES.calendarWrite, 'calendar')).toBe(true);
  });

  it('con el permiso viejo (solo leer) explica el paso, sin llamar a Calendar', async () => {
    const { f, calls } = fake(() => ({ status: 200 }));
    const t = await crearEvento(
      { vault: vault(GOOGLE_SCOPES.calendar.join(' ')), fetch: f, timeZone: TZ },
      { titulo: 'Dentista', inicio: '2026-11-12T10:00' },
    );
    expect(t).toContain('/google conectar');
    expect(calls).toEqual([]);
  });

  it('sin Google conectado lo dice en castellano', async () => {
    const t = await buscarContacto({ vault: vault(ALL, false) }, 'Ana');
    expect(t).toContain('no está conectada');
  });

  it('apunta un evento en su zona horaria, de una hora por defecto', async () => {
    const { f, calls } = fake(() => ({
      status: 200,
      json: { id: 'ev1', start: { dateTime: '2026-11-12T10:00:00+01:00' } },
    }));
    const t = await crearEvento(
      { vault: vault(), fetch: f, timeZone: TZ },
      { titulo: 'Dentista', inicio: '2026-11-12T10:00', lugar: 'Gijón' },
    );
    expect(t).toContain('Apuntado en tu Google Calendar: «Dentista»');
    const post = calls.find((c) => c.method === 'POST' && c.url.includes('/calendar/v3/'));
    expect(JSON.parse(post?.body ?? '{}')).toEqual({
      summary: 'Dentista',
      start: { dateTime: '2026-11-12T10:00:00', timeZone: 'Europe/Madrid' },
      end: { dateTime: '2026-11-12T11:00:00', timeZone: 'Europe/Madrid' },
      location: 'Gijón',
    });
  });

  it('mover usa PATCH sobre el id; fechas de todo el día', async () => {
    const { f, calls } = fake(() => ({
      status: 200,
      json: { summary: 'ITV', start: { date: '2026-11-15' } },
    }));
    const t = await moverEvento(
      { vault: vault(), fetch: f, timeZone: TZ },
      { id: 'ev 1', inicio: '2026-11-15' },
    );
    expect(t).toContain('«ITV»');
    const p = calls.find((c) => c.method === 'PATCH');
    expect(p?.url).toContain('/events/ev%201');
    expect(JSON.parse(p?.body ?? '{}')).toEqual({
      start: { date: '2026-11-15' },
      end: { date: '2026-11-16' },
    });
    expect(() => calTime('mañana', 'Europe/Madrid')).toThrow('No entiendo la fecha');
  });

  it('API sin activar en Google Cloud: dice cuál activar', async () => {
    const { f } = fake(() => ({
      status: 403,
      text: '{"error":{"status":"PERMISSION_DENIED","message":"People API has not been used in project"}}',
    }));
    const t = await buscarContacto({ vault: vault(), fetch: f }, 'Ana');
    expect(t).toContain('People API');
  });

  it('busca un contacto con teléfono y correo (calienta la caché primero)', async () => {
    const { f, calls } = fake((c) =>
      c.url.includes('query=Ana')
        ? {
            status: 200,
            json: {
              results: [
                {
                  person: {
                    names: [{ displayName: 'Ana Pérez' }],
                    phoneNumbers: [{ value: '+34 600 000 000' }],
                    emailAddresses: [{ value: 'ana@example.com' }],
                  },
                },
              ],
            },
          }
        : { status: 200, json: {} },
    );
    const t = await buscarContacto({ vault: vault(), fetch: f }, 'Ana');
    expect(t).toBe('• Ana Pérez — 📞 +34 600 000 000 — ✉️ ana@example.com');
    expect(calls.filter((c) => c.url.includes('people.googleapis.com'))).toHaveLength(2);
  });

  it('lee un Google Doc exportándolo a texto; un binario no', async () => {
    const { f, calls } = fake((c) =>
      c.url.includes('/export?')
        ? { status: 200, text: 'Apuntes de derecho civil' }
        : c.url.includes('doc1')
          ? {
              status: 200,
              json: { id: 'doc1', name: 'Civil', mimeType: 'application/vnd.google-apps.document' },
            }
          : { status: 200, json: { id: 'z', name: 'foto.jpg', mimeType: 'image/jpeg' } },
    );
    const d = { vault: vault(), fetch: f };
    expect(await leerDrive(d, 'doc1')).toBe('«Civil»:\nApuntes de derecho civil');
    expect(calls.some((c) => c.url.includes('mimeType=text%2Fplain'))).toBe(true);
    expect(await leerDrive(d, 'z')).toContain('solo leo documentos');
  });

  it('la Gate: leer no pregunta, cambiar el calendario pregunta siempre', async () => {
    const gate = new Gate({ approver: () => false, allowActions: GOOGLE_READ_ACTIONS });
    expect(gate.classifyEffect({ tool: 'google', args: { action: 'contacto' }, actor: 't' })).toBe(
      'lee',
    );
    expect(
      gate.classifyEffect({ tool: 'google', args: { action: 'evento_borrar' }, actor: 't' }),
    ).toBeNull();
    const leer = await gate.check('s', {
      tool: 'google',
      args: { action: 'drive_buscar', texto: 'x' },
      actor: 't',
    });
    expect(leer.verdict).toBe('allow');
    const crear = await gate.check('s', {
      tool: 'google',
      args: { action: 'evento_crear', titulo: 'x' },
      actor: 't',
    });
    expect(crear.verdict).not.toBe('allow');
  });

  it('/google enseña qué permisos faltan', async () => {
    const r = await googleChatCommand('', {
      vault: vault(GOOGLE_SCOPES.calendar.join(' ')),
      openBrowser: async () => true,
      notify: () => {},
    });
    expect(r.text).toContain('✅ leer tu Google Calendar');
    expect(r.text).toContain('❌ buscar y leer tus archivos de Google Drive');
    expect(r.text).toContain('/google conectar');
  });

  it('/google conectar abre el permiso en el PC con todos los permisos', async () => {
    const abiertos: string[] = [];
    const r = await googleChatCommand('conectar', {
      vault: vault(),
      openBrowser: async (u) => {
        abiertos.push(u);
        return true;
      },
      notify: () => {},
    });
    expect(r.text).toContain('navegador del PC');
    const u = new URL(abiertos[0] ?? 'https://x');
    expect(u.searchParams.get('scope')?.split(' ')).toEqual(DEFAULT_SCOPES);
    expect(u.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    // Cierra el servidor de vuelta que quedó escuchando.
    await fetch(
      `${u.searchParams.get('redirect_uri')}/?state=${u.searchParams.get('state')}`,
    ).catch(() => {});
  });
});
