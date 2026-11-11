import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extrasBandeja, previstoFilas } from '../src/previsto.js';

// bugs-34: /previsto enseñaba «21:30 📥 resumen de la bandeja» siempre, aunque la bandeja
// estuviera vacía (y vacía no se manda nada) o el resumen de hoy ya hubiera salido con
// /bandeja resumen (esta noche ya no vuelve a salir).
const prevTz = process.env.PA_TIMEZONE;
beforeEach(() => {
  process.env.PA_TIMEZONE = 'Europe/Madrid';
});
afterEach(() => {
  if (prevTz === undefined) delete process.env.PA_TIMEZONE;
  else process.env.PA_TIMEZONE = prevTz;
});

const now = new Date('2026-11-11T12:00:00+01:00');
const CADA = '30 21 * * *';

describe('/previsto: el resumen de la bandeja dice si va a salir', () => {
  it('con cosas: cuántas lleva esta noche', () => {
    const ex = extrasBandeja(CADA, now, { pendientes: 3, yaSalioHoy: false });
    expect(ex[0]).toMatchObject({ text: '📥 resumen de la bandeja (3 cosas)' });
    expect(ex[0]?.at.toISOString()).toBe('2026-11-11T20:30:00.000Z');
    expect(extrasBandeja(CADA, now, { pendientes: 1, yaSalioHoy: false })[0]?.text).toBe(
      '📥 resumen de la bandeja (1 cosa)',
    );
  });

  it('vacía: «solo si le mandas algo»; las noches siguientes «si hay algo»', () => {
    const ex = extrasBandeja(CADA, now, { pendientes: 0, yaSalioHoy: false });
    expect(ex.map((e) => e.text)).toEqual([
      '📥 resumen de la bandeja (solo si le mandas algo)',
      '📥 resumen de la bandeja (si hay algo)',
    ]);
    const semana = previstoFilas([], () => null, 'semana', now, ex);
    expect(semana.filas).toHaveLength(7);
    expect(semana.filas.filter((f) => f.text.endsWith('(si hay algo)'))).toHaveLength(6);
  });

  it('si hoy ya salió, esta noche no se enseña', () => {
    const ex = extrasBandeja(CADA, now, { pendientes: 2, yaSalioHoy: true });
    const dia = previstoFilas([], () => null, 'hoy', now, ex);
    expect(dia.filas).toEqual([]);
    expect(ex[0]?.at.toISOString()).toBe('2026-11-12T20:30:00.000Z');
  });
});
