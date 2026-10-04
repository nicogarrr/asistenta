import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { type GymState, OpenGymError } from '../opengym/client.js';
import { lastWorkoutText, todayText, weeklyGymText, weightText } from '../opengym/summary.js';

/**
 * Consulta de SOLO LECTURA a openGym, el tracker de gimnasio de Nico.
 * El modelo elige qué mirar; no puede cambiar la URL ni escribir nada.
 */
const Params = Type.Object({
  what: Type.Union(
    [Type.Literal('hoy'), Type.Literal('ultimo'), Type.Literal('peso'), Type.Literal('semana')],
    {
      description:
        'hoy: qué rutina toca hoy. ultimo: el último entreno. peso: peso corporal. semana: resumen de la semana.',
    },
  ),
});

export type GymKind = 'hoy' | 'ultimo' | 'peso' | 'semana';

export interface OpenGymDeps {
  /** El estado actual, o lanza OpenGymError con un motivo en español. */
  load: () => Promise<GymState | null>;
  now?: () => Date;
}

/** Texto de una consulta, o el motivo honesto de por qué no se pudo. */
export async function gymAnswer(deps: OpenGymDeps, what: GymKind): Promise<string> {
  let state: GymState | null;
  try {
    state = await deps.load();
  } catch (err) {
    if (err instanceof OpenGymError) return `No he podido consultar openGym: ${err.message}.`;
    return 'No he podido consultar openGym por un fallo inesperado.';
  }
  if (!state) return 'openGym no tiene datos todavía (no se ha sincronizado nada).';
  const now = (deps.now ?? (() => new Date()))();
  switch (what) {
    case 'hoy':
      return todayText(state, now);
    case 'ultimo':
      return lastWorkoutText(state);
    case 'peso':
      return weightText(state, now);
    case 'semana':
      return weeklyGymText(state, now);
  }
}

export function createOpenGymTool(deps: OpenGymDeps): AgentTool<typeof Params> {
  return {
    name: 'opengym',
    label: 'openGym (solo lectura)',
    description: [
      "Read Nico's gym tracker (openGym), read-only: what workout is planned today,",
      'the last workout, body weight, or this week summary. Use it for "qué entreno hoy",',
      '"qué hice en el último entreno", "cuánto peso", "cómo voy esta semana en el gym".',
      'It cannot log or change anything. If it fails, tell the user the reason in Spanish;',
      'never invent workout data.',
    ].join(' '),
    parameters: Params,
    execute: async (_id, params) => {
      const text = await gymAnswer(deps, params.what);
      return { content: [{ type: 'text', text }], details: { what: params.what } };
    },
  };
}
