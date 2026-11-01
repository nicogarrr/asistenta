import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Gate } from '../src/permissions.js';
import { calidad, createAireTool, GIJON } from '../src/tools/aire.js';

// Respuesta real de la API de calidad del aire de Open-Meteo para Gijón (1-nov-2026, 11:00).
const RAW = readFileSync(new URL('./fixtures/open-meteo-aire.json', import.meta.url), 'utf8');
const NOW = () => new Date('2026-11-01T10:20:00Z'); // 11:20 en Madrid

const textOf = (r: { content: { type: string; text?: string }[] }): string =>
  r.content.map((c) => c.text ?? '').join('');

const fake = (body: string, urls: string[] = [], status = 200): typeof fetch =>
  (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

/** La misma respuesta con otros valores: polen de gramíneas y el aire de mañana. */
function con(cambios: (d: { hourly: Record<string, (number | null)[]> }) => void): string {
  const d = JSON.parse(RAW) as { hourly: Record<string, (number | null)[]> };
  cambios(d);
  return JSON.stringify(d);
}

describe('tool aire: «¿cómo está el aire?» y «¿hay polen?»', () => {
  it('Gijón por defecto: el aire de ahora, mañana y el polen fuera de temporada', async () => {
    const urls: string[] = [];
    const t = createAireTool(() => null, { fetchFn: fake(RAW, urls), now: NOW });
    expect(textOf(await t.execute('t', {}))).toBe(
      [
        'Calidad del aire en Gijón ahora: razonablemente buena (índice europeo 27). PM2,5 8,7 · PM10 11,6 · NO₂ 2,6 · ozono 70 µg/m³.',
        'Mañana, como mucho, razonablemente buena.',
        'Polen hoy y mañana: nada (fuera de temporada).',
        '(Datos de Copernicus; el polen es orientativo.)',
      ].join('\n'),
    );
    expect(urls).toHaveLength(1);
    const u = new URL(urls[0] ?? '');
    expect(u.host).toBe('air-quality-api.open-meteo.com');
    expect(u.searchParams.get('latitude')).toBe(String(GIJON.latitude));
    expect(u.searchParams.get('timezone')).toBe('Europe/Madrid');
  });

  it('con polen y un día peor: lo dice por tipo y nivel', async () => {
    const body = con((d) => {
      const g = d.hourly.grass_pollen ?? [];
      for (let i = 0; i < g.length; i++) g[i] = i < 24 ? 30 : 60;
      const b = d.hourly.birch_pollen ?? [];
      for (let i = 0; i < b.length; i++) b[i] = 3;
      const a = d.hourly.european_aqi ?? [];
      a[15] = 45; // hoy a las 15:00
      a[36] = 65; // mañana a las 12:00
    });
    const t = createAireTool(() => ({ latitude: 43.36, longitude: -5.85, label: 'Oviedo' }), {
      fetchFn: fake(body),
      now: NOW,
    });
    expect(textOf(await t.execute('t', {}))).toBe(
      [
        'Calidad del aire en Oviedo ahora: razonablemente buena (índice europeo 27). PM2,5 8,7 · PM10 11,6 · NO₂ 2,6 · ozono 70 µg/m³.',
        'Hoy llega a regular hacia las 15:00; mañana, como mucho, desfavorable.',
        'Polen hoy: gramíneas moderado; mañana: gramíneas alto.',
        '(Datos de Copernicus; el polen es orientativo.)',
      ].join('\n'),
    );
  });

  it('índice europeo con sus nombres oficiales', () => {
    expect([0, 20, 21, 40, 59, 61, 85, 140].map(calidad)).toEqual([
      'buena',
      'buena',
      'razonablemente buena',
      'razonablemente buena',
      'regular',
      'desfavorable',
      'muy desfavorable',
      'extremadamente desfavorable',
    ]);
  });

  it('servicio caído, sin red o respuesta rara: mensaje amable sin el error crudo', async () => {
    const down = 'No pude consultar la calidad del aire ahora mismo. Prueba otra vez en un rato.';
    const boom = (async () => {
      throw new Error('fetch failed ECONNREFUSED');
    }) as unknown as typeof fetch;
    for (const fetchFn of [fake('{}', [], 503), boom, fake('<html>', []), fake('{"current":{}}')]) {
      const t = createAireTool(() => null, { fetchFn, now: NOW });
      expect(textOf(await t.execute('t', {}))).toBe(down);
    }
  });

  it('caché de 30 minutos: dos preguntas, una llamada', async () => {
    const urls: string[] = [];
    const t = createAireTool(() => null, { fetchFn: fake(RAW, urls), now: NOW });
    await t.execute('t', {});
    await t.execute('t', {});
    expect(urls).toHaveLength(1);
  });

  it('la puerta: siempre lectura', () => {
    const gate = new Gate({ approver: () => true });
    expect(gate.classifyEffect({ tool: 'aire', args: {}, actor: 'test' })).toBe('lee');
  });
});
