import { describe, expect, it } from 'vitest';
import { fetchWeatherLine } from '../src/briefing-daily.js';
import { createWeatherTool } from '../src/tools/weather.js';

// Si Open-Meteo devuelve el día de hoy sin temperaturas (pasa con la previsión a medio
// actualizar), ese día se salta… y la previsión de mañana salía como «hoy», la de pasado
// como «mañana». El resumen diario decía «Tiempo en Gijón» con la de mañana.

const meteo = (): typeof fetch =>
  (async () =>
    new Response(
      JSON.stringify({
        daily: {
          time: ['2026-11-01', '2026-11-02', '2026-11-03'],
          weather_code: [null, 61, 0],
          temperature_2m_max: [null, 14, 16],
          temperature_2m_min: [null, 9, 7],
          precipitation_probability_max: [null, 70, 0],
        },
      }),
      { status: 200 },
    )) as unknown as typeof fetch;

const cfg = { latitude: 43.5, longitude: -5.7, label: 'Gijón' };

describe('tiempo: un día sin datos no corre las etiquetas', () => {
  it('si falta hoy, mañana sigue siendo «mañana»', async () => {
    const tool = createWeatherTool(() => cfg, meteo());
    const out = (await tool.execute('t', { dias: 3 })).content
      .map((c) => (c as { text: string }).text)
      .join('');
    expect(out).not.toContain('hoy:');
    expect(out).toContain('mañana: 9–14 °C, lluvia (70 %)');
    expect(out).toContain('martes 3: 7–16 °C, despejado');
  });

  it('el resumen diario no da la de mañana como la de hoy', async () => {
    expect(await fetchWeatherLine(cfg, meteo())).toBeNull();
  });
});
