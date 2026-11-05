/**
 * Tool «tiempo» para cualquier sitio. Antes solo daba la previsión del sitio de .env y, para
 * «¿llueve el sábado en Madrid?», el modelo tenía que buscar en la web (lento y con datos
 * sueltos). Ahora:
 * - `lugar`: busca la ciudad con el buscador gratuito de Open-Meteo (prefiere España, o la
 *   región o el país que se diga: «Mérida, México») y da su previsión;
 * - `lat`/`lon`: la previsión de una ubicación compartida por Telegram;
 * - un sitio que no existe lo dice sin inventar.
 * Red simulada.
 */
import { describe, expect, it } from 'vitest';
import { createWeatherTool, geocodePlace } from '../src/tools/weather.js';

const DAILY = {
  daily: {
    time: ['2026-11-05', '2026-11-06'],
    weather_code: [0, 61],
    temperature_2m_max: [21, 18],
    temperature_2m_min: [10, 11],
    precipitation_probability_max: [0, 80],
  },
};

const GEO: Record<string, unknown> = {
  madrid: {
    results: [
      {
        name: 'Madrid',
        latitude: 40.4165,
        longitude: -3.7026,
        country: 'España',
        country_code: 'ES',
        admin1: 'Madrid',
      },
    ],
  },
  merida: {
    results: [
      {
        name: 'Mérida',
        latitude: 20.97,
        longitude: -89.62,
        country: 'México',
        country_code: 'MX',
        admin1: 'Yucatán',
      },
      {
        name: 'Mérida',
        latitude: 38.9161,
        longitude: -6.3437,
        country: 'España',
        country_code: 'ES',
        admin1: 'Extremadura',
      },
    ],
  },
  zzzz: {},
};

function net(urls: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url.toString());
    if (url.host === 'geocoding-api.open-meteo.com') {
      const name = (url.searchParams.get('name') ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
      return new Response(JSON.stringify(GEO[name] ?? {}), { status: 200 });
    }
    return new Response(JSON.stringify(DAILY), { status: 200 });
  }) as typeof fetch;
}

const textOf = (r: { content: { type: string; text?: string }[] }): string =>
  r.content.map((c) => c.text ?? '').join('');

const HOME = () => ({ latitude: 43.5, longitude: -5.7, label: 'Gijón' });

describe('tiempo en cualquier sitio', () => {
  it('«¿llueve mañana en Madrid?»: busca Madrid y da su previsión, no la de casa', async () => {
    const urls: string[] = [];
    const out = textOf(
      await createWeatherTool(HOME, net(urls)).execute('t', { lugar: 'Madrid', dias: 2 }),
    );
    expect(out).toContain('Tiempo en Madrid, Madrid');
    expect(out).toContain('mañana: 11–18 °C, lluvia (80 %)');
    const forecast = urls.find((u) => u.includes('api.open-meteo.com/v1/forecast')) ?? '';
    expect(forecast).toContain('latitude=40.4165');
    expect(forecast).toContain('longitude=-3.7026');
  });

  it('con varios resultados prefiere España, salvo que diga región o país', async () => {
    const urls: string[] = [];
    expect((await geocodePlace('Mérida', net(urls)))?.label).toBe('Mérida, Extremadura');
    const mx = await geocodePlace('Mérida, México', net(urls));
    expect(mx?.latitude).toBe(20.97);
    expect(mx?.label).toBe('Mérida, México');
  });

  it('una ubicación compartida (lat/lon) no necesita buscador', async () => {
    const urls: string[] = [];
    const out = textOf(
      await createWeatherTool(() => null, net(urls)).execute('t', { lat: 41.38, lon: 2.17 }),
    );
    expect(out).toContain('Tiempo en la ubicación compartida');
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('latitude=41.38');
  });

  it('un sitio que no existe lo dice, sin dar el tiempo de casa', async () => {
    const urls: string[] = [];
    const out = textOf(await createWeatherTool(HOME, net(urls)).execute('t', { lugar: 'Zzzz' }));
    expect(out).toContain('No encuentro «Zzzz»');
    expect(out).not.toContain('Gijón');
    expect(urls.some((u) => u.includes('/v1/forecast'))).toBe(false);
  });

  it('sin .env pero con ciudad, también funciona', async () => {
    const out = textOf(
      await createWeatherTool(() => null, net([])).execute('t', { lugar: 'madrid' }),
    );
    expect(out).toContain('Tiempo en Madrid');
  });
});
