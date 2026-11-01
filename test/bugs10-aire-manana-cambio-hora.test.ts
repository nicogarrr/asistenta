import { describe, expect, it } from 'vitest';
import { createAireTool } from '../src/tools/aire.js';

// «Mañana» era «ahora + 24 h». La noche del cambio de hora de otoño, entre las 0:00 y la 1:00,
// eso caía aún en el mismo día (el día tiene 25 h) y «mañana» repetía hoy; la víspera del de
// primavera, entre las 23:00 y las 24:00, saltaba a pasado mañana. Ahora es el día siguiente
// del calendario.

const dias = (a: string, b: string, pa: number, pb: number) => {
  const time: string[] = [];
  const grass: number[] = [];
  const aqi: number[] = [];
  for (const [dia, p, q] of [
    [a, pa, 15],
    [b, pb, 70],
  ] as const) {
    for (let h = 0; h < 24; h++) {
      time.push(`${dia}T${String(h).padStart(2, '0')}:00`);
      grass.push(p);
      aqi.push(q);
    }
  }
  return {
    current: { european_aqi: 15, pm2_5: 3, pm10: 6, nitrogen_dioxide: 4, ozone: 50 },
    hourly: { time, european_aqi: aqi, grass_pollen: grass },
  };
};

const run = async (raw: unknown, iso: string) => {
  const fetchFn = (async () =>
    new Response(JSON.stringify(raw), { status: 200 })) as unknown as typeof fetch;
  const t = createAireTool(() => null, { fetchFn, now: () => new Date(iso) });
  return (await t.execute('t', {} as never)).content
    .map((c) => (c as { text: string }).text)
    .join('');
};

describe('aire: «mañana» es el día siguiente del calendario', () => {
  it('a las 0:30 del día del cambio de hora de otoño', async () => {
    const out = await run(dias('2026-10-25', '2026-10-26', 0, 60), '2026-10-24T22:30:00Z');
    expect(out).toContain('Polen hoy: nada; mañana: gramíneas alto.');
    expect(out).toContain('Mañana, como mucho, desfavorable.');
  });

  it('a las 23:30 de la víspera del cambio de hora de primavera', async () => {
    const out = await run(dias('2026-03-28', '2026-03-29', 0, 60), '2026-03-28T22:30:00Z');
    expect(out).toContain('Polen hoy: nada; mañana: gramíneas alto.');
  });
});
