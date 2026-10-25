import { describe, expect, it } from 'vitest';
import {
  FORECAST_CACHE_KEY,
  FORECAST_FRESH_MS,
  FORECAST_SHOWN_MS,
  cachedForecastFor,
  forecastCacheKey,
  forecastRetryDelayMs,
  readForecastCache,
  writeForecastCache,
  type Forecast,
} from '../tools/tv-home/src/service/weather';

function fakeStorage (): { store: Map<string, string>; getItem: (k: string) => string | null; setItem: (k: string, v: string) => void } {
  const store = new Map<string, string>();
  return { store, getItem: (k) => (store.has(k) ? store.get(k)! : null), setItem: (k, v) => { store.set(k, v); } };
}

const GIJON = { latitude: 43.5322, longitude: -5.6611, temperatureUnit: 'celsius' as const };
const NOW = 1_800_000_000_000;

const FC: Forecast = {
  now: { temp: 18, unit: '°C', label: 'Despejado', glyph: '☀' },
  hours: [{ hour: 12, temp: 19, glyph: '☀' }],
  days: [{ label: 'Hoy', hi: 21, lo: 12, glyph: '☀' }],
  isDay: true,
  sunrise: '2027-01-14T08:54',
  sunset: '2027-01-14T18:12',
};

describe('tv-home weather cache (patrón Hearth)', () => {
  it('escribe y lee una previsión fresca para la misma ubicación', () => {
    const s = fakeStorage();
    writeForecastCache(s, forecastCacheKey(GIJON), FC, NOW);
    expect(cachedForecastFor(s, GIJON, NOW + FORECAST_FRESH_MS - 1)).toEqual(FC);
  });

  it('la copia se puede seguir mostrando pasado el intervalo de refresco, hasta 6 h', () => {
    const s = fakeStorage();
    writeForecastCache(s, forecastCacheKey(GIJON), FC, NOW);
    expect(cachedForecastFor(s, GIJON, NOW + FORECAST_FRESH_MS + 60_000)).toEqual(FC);
    expect(cachedForecastFor(s, GIJON, NOW + FORECAST_SHOWN_MS - 1)).toEqual(FC);
  });

  it('una lectura más vieja que SHOWN ya no se muestra', () => {
    const s = fakeStorage();
    writeForecastCache(s, forecastCacheKey(GIJON), FC, NOW);
    expect(readForecastCache(s, NOW + FORECAST_SHOWN_MS + 1)).toBeNull();
  });

  it('JSON corrupto o forma incompleta → null', () => {
    const s = fakeStorage();
    s.setItem(FORECAST_CACHE_KEY, '{not json');
    expect(readForecastCache(s, NOW)).toBeNull();
    s.setItem(FORECAST_CACHE_KEY, JSON.stringify({ at: NOW, key: 'k', forecast: { now: { temp: 1 } } }));
    expect(readForecastCache(s, NOW)).toBeNull();
    s.setItem(FORECAST_CACHE_KEY, JSON.stringify({ key: 'k', forecast: FC })); // sin at
    expect(readForecastCache(s, NOW)).toBeNull();
  });

  it('cambiar de unidad o de ciudad invalida la copia (no muestra °C de otra ciudad)', () => {
    const s = fakeStorage();
    writeForecastCache(s, forecastCacheKey(GIJON), FC, NOW);
    expect(cachedForecastFor(s, { ...GIJON, temperatureUnit: 'fahrenheit' }, NOW)).toBeNull();
    expect(cachedForecastFor(s, { ...GIJON, latitude: 40.4168, longitude: -3.7038 }, NOW)).toBeNull();
  });

  it('la clave redondea coordenadas a ~100 m (ruido GPS irrelevante)', () => {
    expect(forecastCacheKey(GIJON)).toBe(forecastCacheKey({ ...GIJON, latitude: 43.53221 }));
    expect(forecastCacheKey(GIJON)).not.toBe(forecastCacheKey({ ...GIJON, latitude: 43.54 }));
  });

  it('storage que falla al escribir no rompe el fetch (cacheo best-effort)', () => {
    const boom = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
    expect(() => writeForecastCache(boom, 'k', FC, NOW)).not.toThrow();
  });
});

describe('forecastRetryDelayMs (backoff Hearth 2→10→30)', () => {
  it('escala 2, 10 y se queda en 30 min', () => {
    expect(forecastRetryDelayMs(1)).toBe(2 * 60_000);
    expect(forecastRetryDelayMs(2)).toBe(10 * 60_000);
    expect(forecastRetryDelayMs(3)).toBe(30 * 60_000);
    expect(forecastRetryDelayMs(10)).toBe(30 * 60_000);
  });
});

describe('TTL durante una sesión abierta', () => {
  it('la misma lectura sirve toda la sesión hasta 6 h, en varios puntos', () => {
    const s = fakeStorage();
    writeForecastCache(s, forecastCacheKey(GIJON), FC, NOW);
    for (const t of [0, 60_000, FORECAST_FRESH_MS, 60 * 60_000, 5 * 60 * 60_000, FORECAST_SHOWN_MS - 1]) {
      expect(cachedForecastFor(s, GIJON, NOW + t)).toEqual(FC);
    }
    expect(cachedForecastFor(s, GIJON, NOW + FORECAST_SHOWN_MS + 1)).toBeNull();
  });
});
