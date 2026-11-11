import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Routine } from '../src/db.js';
import { previstoFilas, previstoTexto } from '../src/previsto.js';

// bugs-34: /previsto enseñaba solo la próxima vez de cada cosa. En «/previsto semana» una
// rutina diaria salía un único día, y el resumen de la bandeja de cada noche, solo hoy.
const prevTz = process.env.PA_TIMEZONE;
beforeEach(() => {
  process.env.PA_TIMEZONE = 'Europe/Madrid';
});
afterEach(() => {
  if (prevTz === undefined) delete process.env.PA_TIMEZONE;
  else process.env.PA_TIMEZONE = prevTz;
});

const now = new Date('2026-11-11T12:00:00+01:00');
const r = (name: string, schedule: string, over: Partial<Routine> = {}): Routine => ({
  id: name,
  scope: 'tg:1',
  name,
  kind: 'schedule',
  params: null,
  steps: null,
  prompt: null,
  schedule,
  enabled: true,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  lastRunAt: null,
  ...over,
});
const first: Record<string, string> = {
  diaria: '2026-11-12T08:00:00+01:00',
  horaria: '2026-11-11T13:00:00+01:00',
  'cada-2-dias': '2026-11-12T09:00:00+01:00',
  festivos: '2026-11-12T07:00:00+01:00',
  'recordatorio-1: llamar al banco': '2026-11-12T10:00:00+01:00',
};
const nextOf = (x: Routine) => (first[x.name] ? new Date(first[x.name] as string) : null);

describe('/previsto: todas las veces del rango, no solo la próxima', () => {
  it('semana: una rutina diaria sale cada día, y el resumen de la bandeja cada noche', () => {
    const bandeja = [
      {
        at: new Date('2026-11-11T21:30:00+01:00'),
        text: '📥 resumen de la bandeja',
        cada: '30 21 * * *',
      },
    ];
    const out = previstoFilas([r('diaria', '0 8 * * *')], nextOf, 'semana', now, bandeja);
    const diaria = out.filas.filter((f) => f.text === 'rutina «diaria»');
    expect(diaria).toHaveLength(7);
    expect(diaria.map((f) => f.at.toISOString().slice(0, 10))).toEqual([
      '2026-11-12',
      '2026-11-13',
      '2026-11-14',
      '2026-11-15',
      '2026-11-16',
      '2026-11-17',
      '2026-11-18',
    ]);
    expect(out.filas.filter((f) => f.text === '📥 resumen de la bandeja')).toHaveLength(7);
  });

  it('una rutina cada hora sale una vez por día, con cuántas veces y hasta cuándo', () => {
    const out = previstoFilas([r('horaria', '0 * * * *')], nextOf, 'dia', now);
    expect(out.filas.map((f) => f.text)).toEqual([
      'rutina «horaria» · 11 veces, hasta las 23:00',
      'rutina «horaria» · 13 veces, hasta las 12:00',
    ]);
    const text = previstoTexto(out, 'dia', now);
    expect(text).toContain('• 13:00 🔁 rutina «horaria» · 11 veces, hasta las 23:00');
    expect(text).toContain('• mañana 00:00 🔁 rutina «horaria» · 13 veces, hasta las 12:00');
  });

  it('«cada 2 días» se salta el día de en medio; «excepto festivos» solo la próxima', () => {
    const out = previstoFilas(
      [
        r('cada-2-dias', '0 9 * * *', { prompt: 'regar las plantas cada 2 días' }),
        r('festivos', '0 7 * * 1-5', { prompt: 'despiértame excepto festivos' }),
      ],
      nextOf,
      'semana',
      now,
    );
    const riego = out.filas.filter((f) => f.text.includes('cada-2-dias'));
    expect(riego.map((f) => f.at.toISOString().slice(0, 10))).toEqual([
      '2026-11-12',
      '2026-11-14',
      '2026-11-16',
      '2026-11-18',
    ]);
    expect(out.filas.filter((f) => f.text.includes('festivos'))).toHaveLength(1);
  });

  it('un recordatorio de una vez sale una vez aunque su cron se repita', () => {
    const una = r('recordatorio-1: llamar al banco', '0 10 12 11 *', { prompt: 'llamar al banco' });
    const out = previstoFilas([una], nextOf, 'semana', now);
    expect(out.filas.map((f) => f.text)).toEqual(['llamar al banco']);
  });
});
