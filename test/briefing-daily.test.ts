import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildBriefing } from '../src/briefing.js';
import {
  _resetDailyBriefingForTests,
  type DailyBriefingDeps,
  fetchWeatherLine,
  followupsDue,
  pickImportantMail,
  runDailyBriefingIfDue,
  scheduledForToday,
  weatherConfigFromEnv,
} from '../src/briefing-daily.js';

/** Viernes 30 de octubre de 2026, hora local (la suite fija TZ=Europe/Madrid). */
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute, 0, 0);

function deps(over: Partial<DailyBriefingDeps> = {}) {
  let last = 0;
  const sent: Array<{ chatId: string; text: string }> = [];
  const d: DailyBriefingDeps = {
    enabled: () => true,
    now: () => at(30, 8, 5),
    lastSent: () => last,
    markSent: (ms) => {
      last = ms;
    },
    owner: () => '42',
    send: async (chatId, text) => {
      sent.push({ chatId, text });
      return true;
    },
    agenda: async () => [{ title: 'Dentista', when: '10:30' }],
    sourceTimeoutMs: 50,
    ...over,
  };
  return { d, sent, last: () => last };
}

afterEach(() => _resetDailyBriefingForTests());

describe('runDailyBriefingIfDue', () => {
  it('apagado por defecto: sin PA_BRIEFING no manda nada', async () => {
    const { d, sent } = deps({ enabled: () => false });
    expect((await runDailyBriefingIfDue(d)).status).toBe('disabled');
    expect(sent).toHaveLength(0);
  });

  it('a las 08:05 manda el resumen al DM del dueño, una sola vez al día', async () => {
    const { d, sent, last } = deps();
    const r = await runDailyBriefingIfDue(d);
    expect(r.status).toBe('sent');
    expect(sent).toEqual([{ chatId: '42', text: expect.stringContaining('- 10:30: Dentista') }]);
    expect(sent[0]?.text.startsWith('Buenos días')).toBe(true);
    expect(last()).toBe(at(30, 8, 5).getTime());
    // El tick de 10 min siguiente no repite.
    d.now = () => at(30, 8, 15);
    expect((await runDailyBriefingIfDue(d)).status).toBe('not-due');
    expect(sent).toHaveLength(1);
    // Al día siguiente vuelve a tocar.
    d.now = () => at(31, 8, 1);
    expect((await runDailyBriefingIfDue(d)).status).toBe('sent');
  });

  it('antes de la hora no toca, y la hora es configurable', async () => {
    const { d, sent } = deps({ now: () => at(30, 7, 50) });
    expect((await runDailyBriefingIfDue(d)).status).toBe('not-due');
    d.hour = 7;
    expect((await runDailyBriefingIfDue(d)).status).toBe('sent');
    expect(sent).toHaveLength(1);
  });

  it('si el PC despierta pasado el mediodía, el de hoy se salta sin mensaje', async () => {
    const { d, sent, last } = deps({ now: () => at(30, 19, 0) });
    expect((await runDailyBriefingIfDue(d)).status).toBe('skipped-late');
    expect(sent).toHaveLength(0);
    expect(last()).toBeGreaterThan(0);
    expect((await runDailyBriefingIfDue(d)).status).toBe('not-due');
  });

  it('un día sin nada no manda «no tienes nada»', async () => {
    const { d, sent } = deps({ agenda: async () => [] });
    expect((await runDailyBriefingIfDue(d)).status).toBe('skipped-empty');
    expect(sent).toHaveLength(0);
  });

  it('sin dueño verificado no envía ni da el día por hecho', async () => {
    const { d, sent, last } = deps({ owner: () => null });
    expect((await runDailyBriefingIfDue(d)).status).toBe('no-owner');
    expect(sent).toHaveLength(0);
    expect(last()).toBe(0);
  });

  it('si Telegram falla, reintenta en el siguiente tick', async () => {
    let fail = true;
    const { d, sent } = deps();
    d.send = async (chatId, text) => {
      if (fail) throw new Error('telegram caído');
      sent.push({ chatId, text });
      return true;
    };
    expect((await runDailyBriefingIfDue(d)).status).toBe('send-failed');
    fail = false;
    d.now = () => at(30, 8, 15);
    expect((await runDailyBriefingIfDue(d)).status).toBe('sent');
    expect(sent).toHaveLength(1);
  });

  it('una fuente colgada o rota se omite y el resto sale', async () => {
    const warn = vi.fn();
    const { d, sent } = deps({
      warn,
      weather: () => new Promise(() => {}),
      mail: async () => {
        throw new Error('IMAP caído');
      },
      followups: () => [{ subject: 'Llamar al seguro', due: 'hoy' }],
    });
    const r = await runDailyBriefingIfDue(d);
    expect(r.status).toBe('sent');
    expect(sent[0]?.text).toContain('Dentista');
    expect(sent[0]?.text).toContain('Seguimientos\n- Llamar al seguro (hoy)');
    expect(sent[0]?.text).not.toContain('Tiempo');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('dos ticks a la vez no mandan dos resúmenes', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { d, sent } = deps({
      agenda: async () => {
        await gate;
        return [{ title: 'Dentista', when: '10:30' }];
      },
      sourceTimeoutMs: 5_000,
    });
    const first = runDailyBriefingIfDue(d);
    expect((await runDailyBriefingIfDue(d)).status).toBe('busy');
    release();
    expect((await first).status).toBe('sent');
    expect(sent).toHaveLength(1);
  });
});

describe('buildBriefing con tiempo y correo', () => {
  it('el tiempo va pegado al saludo y el correo tras la agenda', () => {
    const text = buildBriefing({
      greeting: 'Buenos días',
      today: at(30, 8),
      agenda: [{ title: 'Dentista', when: '10:30' }],
      routines: [],
      reminders: [{ text: 'Sacar la basura', at: '21:00' }],
      followups: [],
      weather: 'Tiempo en Madrid: 9–19 °C, despejado',
      mail: [{ from: 'Ana Pérez', subject: 'Contrato firmado' }],
    });
    expect(text.split('\n').slice(0, 2)).toEqual([
      'Buenos días',
      'Tiempo en Madrid: 9–19 °C, despejado',
    ]);
    expect(text.indexOf('\nHoy\n')).toBeLessThan(
      text.indexOf('\nCorreo\n- Ana Pérez: Contrato firmado'),
    );
    expect(text.indexOf('\nCorreo\n')).toBeLessThan(text.indexOf('\nRecordatorios\n'));
  });
});

describe('pickImportantMail', () => {
  const now = at(30, 8).getTime();
  const m = (from: string, subject: string, hoursAgo: number, seen = false) => ({
    from,
    subject,
    at: now - hoursAgo * 3_600_000,
    seen,
  });
  it('solo sin leer, de las últimas 24 h, sin boletines, el más nuevo primero y máximo 3', () => {
    const picked = pickImportantMail(
      [
        m('"Ana Pérez" <ana@x.es>', 'Contrato', 2),
        m('juan@x.es', 'Cena del sábado', 1),
        m('Banco <no-reply@banco.es>', 'Tu extracto', 1),
        m('tienda@shop.es', '¡30% de descuento solo hoy!', 1),
        m('luis@x.es', 'Leído ya', 1, true),
        m('marta@x.es', 'De anteayer', 40),
        m('pepe@x.es', 'Factura', 3),
        m('eva@x.es', 'Cuarto', 4),
      ],
      now,
    );
    expect(picked).toEqual([
      { from: 'juan@x.es', subject: 'Cena del sábado' },
      { from: 'Ana Pérez', subject: 'Contrato' },
      { from: 'pepe@x.es', subject: 'Factura' },
    ]);
  });
});

describe('tiempo (Open-Meteo, sin clave)', () => {
  it('lee las coordenadas del entorno y descarta las inválidas', () => {
    expect(
      weatherConfigFromEnv({
        PA_BRIEFING_LAT: '40,4168',
        PA_BRIEFING_LON: '-3.7038',
        PA_BRIEFING_PLACE: 'Madrid',
      }),
    ).toEqual({
      latitude: 40.4168,
      longitude: -3.7038,
      label: 'Madrid',
    });
    expect(weatherConfigFromEnv({})).toBeNull();
    expect(weatherConfigFromEnv({ PA_BRIEFING_LAT: '200', PA_BRIEFING_LON: '0' })).toBeNull();
  });

  it('compone una línea en español con mínima, máxima, cielo y lluvia', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain('latitude=40.4&longitude=-3.7');
      return new Response(
        JSON.stringify({
          daily: {
            weather_code: [61],
            temperature_2m_max: [18.6],
            temperature_2m_min: [9.2],
            precipitation_probability_max: [70],
          },
        }),
      );
    });
    const line = await fetchWeatherLine(
      { latitude: 40.4, longitude: -3.7, label: 'Madrid' },
      fetchFn as typeof fetch,
    );
    expect(line).toBe('Tiempo en Madrid: 9–19 °C, lluvia (70 %)');
  });

  it('un error HTTP se propaga (el resumen lo omite)', async () => {
    const fetchFn = vi.fn(async () => new Response('x', { status: 503 }));
    await expect(
      fetchWeatherLine({ latitude: 1, longitude: 1 }, fetchFn as typeof fetch),
    ).rejects.toThrow('503');
  });
});

describe('rutinas, recordatorios y seguimientos de hoy', () => {
  it('separa recordatorios de rutinas y deja fuera mañana y las desactivadas', () => {
    const now = at(30, 8);
    const out = scheduledForToday(
      [
        {
          name: 'recordatorio-1: sacar la basura',
          prompt: null,
          enabled: true,
          next: at(30, 21).toISOString(),
        },
        { name: 'Revisar correo', prompt: 'x', enabled: true, next: at(30, 9, 30).toISOString() },
        { name: 'Mañana', prompt: null, enabled: true, next: at(31, 9).toISOString() },
        { name: 'Apagada', prompt: null, enabled: false, next: at(30, 10).toISOString() },
        { name: 'Sin próxima', prompt: null, enabled: true, next: null },
      ],
      now,
    );
    expect(out.routines).toEqual([{ name: 'Revisar correo', nextRun: '09:30' }]);
    expect(out.reminders).toEqual([{ text: 'sacar la basura', at: '21:00' }]);
  });

  it('seguimientos pendientes que vencen hoy o ya vencieron', () => {
    const now = at(30, 8);
    const f = followupsDue(
      [
        { subject: 'Hoy', dueAt: at(30, 18).getTime(), status: 'pending' },
        { subject: 'Viejo', dueAt: at(27, 18).getTime(), status: 'pending' },
        { subject: 'Hecho', dueAt: at(29, 18).getTime(), status: 'done' },
        { subject: 'Futuro', dueAt: at(2, 18).getTime() + 31 * 86_400_000, status: 'pending' },
      ],
      now,
    );
    expect(f).toEqual([
      { subject: 'Viejo', due: 'vencido' },
      { subject: 'Hoy', due: 'hoy' },
    ]);
  });
});
