/**
 * Tool «tiempo» hora a hora. Antes solo daba días («hoy: 10–18 °C, lluvia (70 %)»): a
 * «¿llueve esta tarde?» o «¿a qué hora para de llover?» no había respuesta concreta. Ahora,
 * con `horas`, trae las próximas N horas y, primero, los tramos con lluvia probable
 * («de 15:00 a 18:00»). Red simulada.
 */
import { describe, expect, it } from 'vitest';
import { createWeatherTool, hourlyText, type WeatherHour } from '../src/tools/weather.js';

const H = (time: string, temp: number, rainProb = 0, rainMm = 0, code = 3): WeatherHour => ({
  time,
  temp,
  rainProb,
  rainMm,
  code,
});

const textOf = (r: { content: { type: string; text?: string }[] }): string =>
  r.content.map((c) => c.text ?? '').join('');

describe('tiempo hora a hora', () => {
  it('«¿a qué hora para de llover?»: dice el tramo con lluvia y cada hora', async () => {
    const urls: string[] = [];
    const times = ['13', '14', '15', '16', '17', '18'].map((h) => `2026-11-05T${h}:00`);
    const net = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(
        JSON.stringify({
          hourly: {
            time: times,
            temperature_2m: [14.2, 14, 13.4, 12.8, 12, 11.5],
            precipitation_probability: [10, 20, 70, 85, 60, 10],
            precipitation: [0, 0, 0.8, 2.1, 0.4, 0],
            weather_code: [3, 3, 61, 63, 61, 3],
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const tool = createWeatherTool(
      () => ({ latitude: 43.5, longitude: -5.7, label: 'Gijón' }),
      net,
    );
    const out = textOf(await tool.execute('t', { horas: 6 }));
    expect(out).toContain('Tiempo hora a hora en Gijón (próximas 6 h):');
    expect(out).toContain('Lluvia probable de 15:00 a 18:00 (hasta 85 %).');
    expect(out).toContain('16:00: 13 °C, lluvia, 85 % de lluvia, 2,1 mm');
    expect(out).toContain('13:00: 14 °C');
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('hourly=');
    expect(urls[0]).toContain('forecast_hours=6');
  });

  it('sin lluvia lo dice; los tramos de mañana llevan «mañana»; más de 24 h van de 2 en 2', () => {
    const dry = hourlyText([H('2026-11-05T20:00', 9), H('2026-11-05T21:00', 8)]);
    expect(dry).toContain('Sin lluvia prevista en las próximas 2 horas.');
    const hours: WeatherHour[] = [];
    for (let i = 0; i < 30; i++) {
      const d = new Date(Date.UTC(2026, 10, 5, 20 + i));
      const t = d.toISOString().slice(0, 16);
      hours.push(H(t, 10, i >= 11 && i <= 12 ? 90 : 0));
    }
    const out = hourlyText(hours, 'Gijón');
    expect(out).toContain('Lluvia probable de mañana 07:00 a 09:00 (hasta 90 %).');
    expect(out.split('\n').filter((l) => /^\S.*: \d+ °C/.test(l))).toHaveLength(15);
  });
});
