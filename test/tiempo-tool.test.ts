import { describe, expect, it } from 'vitest';
import { Gate } from '../src/permissions.js';
import { createWeatherTool } from '../src/tools/weather.js';

const meteo = (urls: string[]): typeof fetch =>
  (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(
      JSON.stringify({
        daily: {
          time: ['2026-10-31', '2026-11-01'],
          weather_code: [0, 61],
          temperature_2m_max: [17.4, 14],
          temperature_2m_min: [8.2, 9],
          precipitation_probability_max: [0, 70],
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;

const textOf = (r: { content: { type: string; text?: string }[] }): string =>
  r.content.map((c) => c.text ?? '').join('');

describe('tool tiempo: «¿qué tiempo hace mañana?»', () => {
  it('da hoy y mañana del sitio configurado, solo con Open-Meteo', async () => {
    const urls: string[] = [];
    const tool = createWeatherTool(
      () => ({ latitude: 40.4, longitude: -3.7, label: 'Madrid' }),
      meteo(urls),
    );
    const out = textOf(await tool.execute('t', { dias: 2 }));
    expect(out).toContain('Tiempo en Madrid');
    expect(out).toContain('hoy: 8–17 °C, despejado');
    expect(out).toContain('mañana: 9–14 °C, lluvia (70 %)');
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0] ?? '').host).toBe('api.open-meteo.com');
    expect(urls[0]).toContain('forecast_days=2');
  });

  it('sin sitio configurado lo dice y no sale a la red', async () => {
    const urls: string[] = [];
    const out = textOf(await createWeatherTool(() => null, meteo(urls)).execute('t', {}));
    expect(out).toContain('PA_BRIEFING_LAT');
    expect(urls).toHaveLength(0);
  });

  it('un fallo del servicio se cuenta sin romper el turno', async () => {
    const down = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    const tool = createWeatherTool(() => ({ latitude: 1, longitude: 2 }), down);
    expect(textOf(await tool.execute('t', {}))).toContain('503');
  });

  it('la puerta la trata como lectura (no pregunta por consultar el tiempo)', () => {
    const gate = new Gate({ approver: () => true });
    expect(gate.classifyEffect({ tool: 'tiempo', args: {}, actor: 'test' })).toBe('lee');
  });
});
