/**
 * Resumen de la mañana: «Tiempo en Gijón: 9–15 °C, lluvia (80 %)» no decía CUÁNDO. Ahora,
 * con la previsión hora a hora de #2048, añade «lluvia probable de 15:00 a 18:00» (solo las
 * horas que quedan de hoy). Si falla la consulta por horas, queda la línea de siempre.
 * Red simulada.
 */
import { describe, expect, it } from 'vitest';
import { briefingWeatherLine, rainTodayText, type WeatherHour } from '../src/tools/weather.js';

const CFG = { latitude: 43.53, longitude: -5.66, label: 'Gijón' };

const H = (time: string, rainProb: number, rainMm = 0): WeatherHour => ({
  time,
  temp: 12,
  rainProb,
  rainMm,
});

function net(
  opts: { hourlyFails?: boolean; probs?: number[]; startHour?: number } = {},
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('daily=')) {
      return new Response(
        JSON.stringify({
          daily: {
            time: ['2026-11-05'],
            weather_code: [61],
            temperature_2m_max: [15],
            temperature_2m_min: [9],
            precipitation_probability_max: [80],
          },
        }),
        { status: 200 },
      );
    }
    if (opts.hourlyFails) return new Response('boom', { status: 503 });
    const start = opts.startHour ?? 8;
    const probs = opts.probs ?? [];
    const time = probs.map((_, i) => {
      const h = start + i;
      const day = h >= 24 ? '2026-11-06' : '2026-11-05';
      return `${day}T${String(h % 24).padStart(2, '0')}:00`;
    });
    return new Response(
      JSON.stringify({
        hourly: {
          time,
          temperature_2m: probs.map(() => 12),
          precipitation_probability: probs,
          precipitation: probs.map((p) => (p >= 50 ? 1 : 0)),
          weather_code: probs.map((p) => (p >= 50 ? 61 : 3)),
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
}

describe('resumen de la mañana: cuándo llueve hoy', () => {
  it('añade «lluvia probable de 15:00 a 18:00» a la línea del día', async () => {
    // 08:00 … 07:00 del día siguiente; lluvia de 15 a 17 (y mañana de madrugada, que no cuenta).
    const probs = Array.from({ length: 24 }, (_, i) => (i >= 7 && i <= 9 ? 80 : i >= 20 ? 90 : 5));
    const line = await briefingWeatherLine(CFG, net({ probs }));
    expect(line).toBe('Tiempo en Gijón: 9–15 °C, lluvia (80 %); lluvia probable de 15:00 a 18:00.');
  });

  it('sin lluvia por horas, la línea de siempre', async () => {
    const line = await briefingWeatherLine(
      CFG,
      net({ probs: Array.from({ length: 24 }, () => 10) }),
    );
    expect(line).toBe('Tiempo en Gijón: 9–15 °C, lluvia (80 %)');
  });

  it('si falla la consulta por horas, queda la del día', async () => {
    expect(await briefingWeatherLine(CFG, net({ hourlyFails: true }))).toBe(
      'Tiempo en Gijón: 9–15 °C, lluvia (80 %)',
    );
  });

  it('dos tramos, tramo hasta medianoche y «y más tarde»', () => {
    expect(
      rainTodayText([
        H('2026-11-05T08:00', 70),
        H('2026-11-05T09:00', 10),
        H('2026-11-05T21:00', 60),
        H('2026-11-05T22:00', 0),
      ]),
    ).toBe('lluvia probable de 08:00 a 09:00 y de 21:00 a 22:00');
    expect(
      rainTodayText([
        H('2026-11-05T22:00', 10),
        H('2026-11-05T23:00', 60),
        H('2026-11-06T00:00', 90),
      ]),
    ).toBe('lluvia probable desde las 23:00 hasta la noche');
    expect(
      rainTodayText([
        H('2026-11-05T08:00', 70),
        H('2026-11-05T09:00', 0),
        H('2026-11-05T10:00', 70),
        H('2026-11-05T11:00', 0),
        H('2026-11-05T12:00', 0, 0.5),
      ]),
    ).toBe('lluvia probable de 08:00 a 09:00 y de 10:00 a 11:00 (y más tarde)');
    expect(rainTodayText([])).toBe('');
  });
});
