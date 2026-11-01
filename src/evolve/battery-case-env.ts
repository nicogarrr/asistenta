// Lectura del caso de la batería desde el entorno, sin dependencias pesadas: el evaluador
// (scripts/evolve-battery-case.mjs) la carga ANTES que el asistente, para que un caso inválido
// se rechace al momento aunque la máquina vaya cargada (antes cargaba todo el agente primero).
import type { BatteryCase } from './battery-judge.js';

/** Lee el caso de PA_BATTERY_CASE; lanza si no es un caso con id y prompt. */
export function caseFromEnv(env: NodeJS.ProcessEnv = process.env): BatteryCase {
  let c: Partial<BatteryCase> | null = null;
  try {
    c = JSON.parse(env.PA_BATTERY_CASE ?? '') as Partial<BatteryCase>;
  } catch {
    c = null;
  }
  if (!c || typeof c.id !== 'string' || typeof c.prompt !== 'string' || !c.prompt.trim())
    throw new Error('PA_BATTERY_CASE no es un caso válido (hace falta id y prompt).');
  return { machine: {}, ...c } as BatteryCase;
}
