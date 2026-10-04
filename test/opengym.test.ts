import { describe, expect, it } from 'vitest';
import {
  OpenGymClient,
  OpenGymError,
  parseBaseUrl,
  redeemPairingCode,
} from '../src/opengym/client.js';
import {
  lastWorkoutText,
  localDate,
  todayText,
  weekday,
  weeklyGymText,
  weightText,
} from '../src/opengym/summary.js';
import { gymAnswer } from '../src/tools/opengym.js';

// 2026-10-04 es domingo (comprobado abajo).
const NOW = new Date('2026-10-04T16:00:00Z');

const state = {
  unit: 'kg',
  reminder: { on: true, time: '08:00', tz: 'Europe/Madrid' },
  routines: [
    { id: 'r1', name: 'Push', ex: [{ id: '0009' }, { id: 'mine1' }] },
    { id: 'r2', name: 'Pull', ex: [] },
  ],
  week: { '1': 'r1', '3': 'r2', '0': 'r2' },
  dayPlan: { '2026-10-04': 'rest', '2026-10-06': 'r1' },
  customEx: [{ id: 'mine1', n: 'Mi remo raro', bp: 'back' }],
  bodyweight: [
    { d: '2026-09-10', w: 81 },
    { d: '2026-09-28', w: 80.4 },
    { d: '2026-10-03', w: 79.8 },
  ],
  workouts: [
    {
      id: 'w1',
      d: '2026-09-30',
      name: 'Pull',
      start: 1_000_000,
      end: 1_000_000 + 55 * 60_000,
      vol: 5234.4,
      prs: ['mine1'],
      entries: [
        {
          id: 'mine1',
          sets: [
            { w: 50, r: 8, done: true },
            { w: 60, r: 5, done: true },
            { w: 90, r: 1, done: false },
          ],
        },
      ],
    },
    {
      id: 'w2',
      d: '2026-10-01',
      name: 'Push',
      entries: [{ id: '0009', sets: [{ w: 20, r: 10, done: true }] }],
      prs: ['0009'],
    },
  ],
};

describe('fechas', () => {
  it('2026-10-04 es domingo y el día local sigue la zona', () => {
    expect(weekday('2026-10-04')).toBe(0);
    expect(localDate(new Date('2026-10-04T23:30:00Z'), 'Europe/Madrid')).toBe('2026-10-05');
  });
});

describe('resúmenes', () => {
  it('hoy: dayPlan manda sobre week', () => {
    expect(todayText(state, NOW)).toContain('día de descanso');
    const lunes = todayText(state, new Date('2026-10-05T08:00:00Z'));
    expect(lunes).toContain('toca Push');
    expect(lunes).toContain('Mi remo raro');
    expect(lunes).toContain('Todavía no has registrado');
    expect(todayText({}, NOW)).toContain('nada planeado');
  });

  it('último: nombre del ejercicio propio, mejor serie hecha (ignora las no hechas) y récords', () => {
    const t = lastWorkoutText(state);
    expect(t).toContain('Push (2026-10-01)');
    expect(t).toContain('mejor serie 20 kg x 10');
    const prev = lastWorkoutText({
      workouts: [state.workouts[0]],
      customEx: state.customEx,
      unit: 'kg',
    });
    expect(prev).toContain('Duración: 55 min');
    expect(prev).toContain('mejor serie 60 kg x 5');
    expect(prev).not.toContain('90');
    expect(prev).toContain('Récords: Mi remo raro');
    expect(lastWorkoutText({})).toContain('ningún entreno');
  });

  it('peso: último y diferencia con 30 días, sin inventar', () => {
    const t = weightText(state, NOW);
    expect(t).toContain('79,8 kg (2026-10-03)');
    expect(t).toContain('-1,2 kg');
    expect(weightText({ bodyweight: [{ d: '2026-10-03', w: 80 }] }, NOW)).toContain(
      'para comparar',
    );
    expect(weightText({}, NOW)).toContain('ningún peso');
  });

  it('semana: hechos vs planeados, récords, peso y músculos sin trabajar', () => {
    // semana lun 28 sep - dom 4 oct: plan = lunes r1, miércoles r2, domingo=rest (dayPlan) => 2 planeados
    const t = weeklyGymText(state, NOW);
    expect(t).toContain('semana del 2026-09-28 al 2026-10-04');
    expect(t).toContain('2 hechos de 2 planeados');
    expect(t).toContain('Récords personales: 2');
    expect(t).toContain('79,8 kg');
    expect(t).toContain('Sin trabajar esta semana:');
    expect(t).toContain('piernas');
    expect(t).not.toMatch(/Sin trabajar[^\n]*espalda/);
    expect(t).not.toMatch(/Sin trabajar[^\n]*pecho/);
  });
});

describe('cliente', () => {
  const mk = (
    handler: (url: string, init: RequestInit) => Response | Promise<Response>,
    token = 'tok'.repeat(10),
  ) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const saved: string[] = [];
    const client = new OpenGymClient({
      baseUrl: 'https://opengym-vm.tailae34cd.ts.net/',
      getToken: async () => token,
      setToken: async (t) => {
        saved.push(t);
      },
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return handler(url, init);
      }) as unknown as typeof fetch,
      now: () => 1_000_000_000,
    });
    return { client, calls, saved };
  };
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

  it('lee /api/data con Bearer, sin seguir redirecciones, y es solo GET', async () => {
    const { client, calls } = mk((url) =>
      url.endsWith('/api/me') ? json({ user: {} }) : json({ state, rev: 7 }),
    );
    const r = await client.getState();
    expect(r.rev).toBe(7);
    expect(calls.map((c) => c.init.method)).toEqual(['GET', 'GET']);
    expect(calls[1]?.url).toBe('https://opengym-vm.tailae34cd.ts.net/api/data');
    expect(calls[1]?.init.redirect).toBe('error');
    expect((calls[1]?.init.headers as Record<string, string>).authorization).toMatch(/^Bearer /);
  });

  it('guarda el token renovado y solo comprueba cada 12 h', async () => {
    const fresh = 'n'.repeat(40);
    const { client, calls, saved } = mk((url) =>
      url.endsWith('/api/me') ? json({ token: fresh }) : json({ state: null, rev: 0 }),
    );
    expect((await client.getState()).state).toBeNull();
    await client.getState();
    expect(saved).toEqual([fresh]);
    expect(calls.filter((c) => c.url.endsWith('/api/me'))).toHaveLength(1);
  });

  it('401 pide emparejar de nuevo; errores de red dicen qué mirar; el token no sale en el mensaje', async () => {
    const a = mk(() => json({ error: 'not signed in' }, 401));
    await expect(a.client.getState()).rejects.toMatchObject({ kind: 'auth' });
    const b = mk(() => {
      throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND opengym') });
    });
    const err = await b.client.getState().catch((e) => e as OpenGymError);
    expect(err).toBeInstanceOf(OpenGymError);
    expect((err as OpenGymError).message).toMatch(/Tailscale/);
    expect((err as OpenGymError).message).not.toContain('tok');
  });

  it('sin token no llama a la red', async () => {
    const c = new OpenGymClient({
      baseUrl: 'https://x.ts.net',
      getToken: async () => undefined,
      setToken: async () => {},
      fetchImpl: (() => {
        throw new Error('no debería llamarse');
      }) as unknown as typeof fetch,
    });
    await expect(c.getState()).rejects.toMatchObject({ kind: 'config' });
  });

  it('valida la URL: https, o http solo en la tailnet/localhost, sin credenciales', () => {
    expect(() => parseBaseUrl('https://opengym-vm.tailae34cd.ts.net/')).not.toThrow();
    expect(() => parseBaseUrl('http://100.101.2.3:8080')).not.toThrow();
    expect(() => parseBaseUrl('http://localhost:8080')).not.toThrow();
    expect(() => parseBaseUrl('http://example.com')).toThrow(/https/);
    expect(() => parseBaseUrl('http://100.64.evil.com')).toThrow(/https/);
    expect(() => parseBaseUrl('http://100.101.2.3.evil.com')).toThrow(/https/);
    expect(() => parseBaseUrl('https://u:p@x.ts.net')).toThrow(/usuario/);
    expect(() => parseBaseUrl('no')).toThrow(/válida/);
  });

  it('emparejar: valida el código, canjea y trata el 400', async () => {
    const tok = 'a'.repeat(40);
    let sent = '';
    const ok = (async (_u: string, init: RequestInit) => {
      sent = String(init.body);
      return json({ token: tok });
    }) as unknown as typeof fetch;
    expect(await redeemPairingCode('https://x.ts.net', 'k7wq2mzp', ok)).toBe(tok);
    expect(JSON.parse(sent)).toEqual({ code: 'K7WQ2MZP' });
    await expect(redeemPairingCode('https://x.ts.net', 'abc', ok)).rejects.toThrow(/8 letras/);
    const bad = (async () =>
      json({ error: 'invalid or expired code' }, 400)) as unknown as typeof fetch;
    await expect(redeemPairingCode('https://x.ts.net', 'K7WQ2MZP', bad)).rejects.toThrow(
      /no acepta/,
    );
  });
});

describe('gymAnswer', () => {
  it('devuelve el motivo en español cuando falla y no inventa datos', async () => {
    const t = await gymAnswer(
      {
        load: async () => {
          throw new OpenGymError('network', 'no consigo conectar');
        },
      },
      'hoy',
    );
    expect(t).toBe('No he podido consultar openGym: no consigo conectar.');
    expect(await gymAnswer({ load: async () => null }, 'peso')).toContain('no tiene datos');
    expect(await gymAnswer({ load: async () => state, now: () => NOW }, 'peso')).toContain(
      '79,8 kg',
    );
  });
});
