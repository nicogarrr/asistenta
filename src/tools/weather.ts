import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { fetchWeatherDays, type WeatherConfig } from '../briefing-daily.js';
import { log } from '../log.js';

const Params = Type.Object({
  dias: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 7, description: 'Días de previsión desde hoy (1-7).' }),
  ),
});

const NO_PLACE =
  'No tengo configurado el sitio para el tiempo: pon PA_BRIEFING_LAT y PA_BRIEFING_LON en .env (y PA_BRIEFING_PLACE para el nombre).';

const dayName = (date: string, i: number): string => {
  if (i === 0) return 'hoy';
  if (i === 1) return 'mañana';
  const at = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(at.getTime())) return `día ${i + 1}`;
  return new Intl.DateTimeFormat('es-ES', {
    weekday: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(at);
};

/**
 * «¿Qué tiempo hace mañana?»: previsión del sitio configurado para el resumen diario
 * (Open-Meteo, gratis, sin clave). Solo lectura: no recibe URL ni lugar del modelo, así
 * que la única salida a la red es ese servicio con las coordenadas de .env.
 */
export function createWeatherTool(
  config: () => WeatherConfig | null,
  fetchFn: typeof fetch = fetch,
): AgentTool<typeof Params> {
  return {
    name: 'tiempo',
    label: 'El tiempo',
    description:
      'Weather forecast (today up to 7 days) for the place configured in .env (PA_BRIEFING_LAT/LON). Use for «qué tiempo hace», «¿llueve mañana?», «¿hará frío el sábado?». Read-only. Only the configured place: for another city, search the web instead.',
    parameters: Params,
    executionMode: 'parallel',
    execute: async (_id, args) => {
      const cfg = config();
      const text = async (): Promise<string> => {
        if (!cfg) return NO_PLACE;
        let days: Awaited<ReturnType<typeof fetchWeatherDays>>;
        try {
          days = await fetchWeatherDays(cfg, args.dias ?? 3, fetchFn);
        } catch (err) {
          // El texto crudo («fetch failed», «HTTP 503») solo al registro: el modelo lo repetía.
          log.warn('tiempo: fallo al consultar', { err: String(err) });
          return 'No pude consultar el tiempo ahora: el servicio no responde. Prueba en un rato.';
        }
        if (days.length === 0) return 'El servicio del tiempo no ha devuelto datos ahora.';
        const lines = days.map((d, i) => `${dayName(d.date, d.offset ?? i)}: ${d.text}`);
        return `Tiempo${cfg.label ? ` en ${cfg.label}` : ''}:\n${lines.join('\n')}`;
      };
      return { content: [{ type: 'text', text: await text() }], details: {} };
    },
  };
}
