import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Routine } from '../src/db.js';
import { previstoFilas, previstoRango, previstoTexto } from '../src/previsto.js';

const prevTz = process.env.PA_TIMEZONE;
beforeEach(() => {
  process.env.PA_TIMEZONE = 'Europe/Madrid';
});
afterEach(() => {
  if (prevTz === undefined) delete process.env.PA_TIMEZONE;
  else process.env.PA_TIMEZONE = prevTz;
});

const now = new Date('2026-11-11T12:00:00+01:00');
const r = (name: string, over: Partial<Routine> = {}): Routine => ({
  id: name,
  scope: 'tg:1',
  name,
  kind: 'schedule',
  params: null,
  steps: null,
  prompt: null,
  schedule: '0 8 * * *',
  enabled: true,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  lastRunAt: null,
  ...over,
});
const at: Record<string, string> = {
  'resumen-mañana': '2026-11-12T08:00:00+01:00',
  'recordatorio-1: pagar la matrícula': '2026-11-11T18:42:00+01:00',
  'precio-luz': '2026-11-14T20:00:00+01:00',
  pausada: '2026-11-11T13:00:00+01:00',
};
const routines = [
  r('resumen-mañana'),
  r('recordatorio-1: pagar la matrícula', { prompt: 'pagar la matrícula' }),
  r('precio-luz'),
  r('pausada', { enabled: false }),
  r('un-procedimiento', { kind: 'procedure', schedule: null }),
];
const nextOf = (x: Routine) => (at[x.name] ? new Date(at[x.name] as string) : null);
const bandeja = [{ at: new Date('2026-11-11T21:30:00+01:00'), text: '📥 resumen de la bandeja' }];

describe('/previsto (Muse: «everything it… plans to do»)', () => {
  it('24 h: por hora, recordatorios como texto, rutinas por nombre y la bandeja', () => {
    const out = previstoFilas(routines, nextOf, 'dia', now, bandeja);
    expect(out.filas.map((f) => f.text)).toEqual([
      'pagar la matrícula',
      '📥 resumen de la bandeja',
      'rutina «resumen-mañana»',
    ]);
    expect(out.pausadas).toBe(1);
    const text = previstoTexto(out, 'dia', now);
    expect(text).toContain('Lo que haré por ti en las próximas 24 h (3)');
    expect(text).toContain('• 18:42 ⏰ pagar la matrícula');
    expect(text).toContain('• 21:30 📥 resumen de la bandeja');
    expect(text).toContain('• mañana 08:00 🔁 rutina «resumen-mañana»');
    expect(text).toContain('⏸️ 1 rutina en pausa no sale');
  });

  it('hoy corta a medianoche; semana agrupa por día', () => {
    const hoy = previstoFilas(routines, nextOf, 'hoy', now, bandeja);
    expect(hoy.filas.map((f) => f.text)).toEqual([
      'pagar la matrícula',
      '📥 resumen de la bandeja',
    ]);
    const semana = previstoFilas(routines, nextOf, 'semana', now, bandeja);
    expect(semana.filas).toHaveLength(4);
    const text = previstoTexto(semana, 'semana', now);
    expect(text).toMatch(/Hoy\n• 18:42/);
    expect(text).toMatch(/\n\S+ 12\/11\n• 08:00 🔁/);
    expect(text).toMatch(/\n\S+ 14\/11\n• 20:00 🔁 rutina «precio-luz»/);
  });

  it('nada previsto lo dice; las órdenes raras no valen', () => {
    const empty = previstoFilas([], nextOf, 'dia', now);
    expect(previstoTexto(empty, 'dia', now)).toContain('Nada previsto para las próximas 24 h');
    expect(previstoRango('')).toBe('dia');
    expect(previstoRango('Semana')).toBe('semana');
    expect(previstoRango('hoy')).toBe('hoy');
    expect(previstoRango('mañana')).toBe('dia');
    expect(previstoRango('pepino')).toBeNull();
  });
});
