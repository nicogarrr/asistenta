// Que casos corre cada ciclo. Pura. El ciclo i (0,1,2 rotando) corre:
// todos los cheap y medium, los heavy 'always', y los heavy cuya rotation == i.
import type { Battery, BatteryCase } from '../evolve/battery-judge.js';

/** Un caso puntua solo si esta activo, lo juzga la maquina y tiene criterios verificables. */
export function scorable(c: BatteryCase): boolean {
  if (c.enabled === false) return false;
  if (c.judge === 'qa') return false;
  return Object.keys(c.machine).length > 0;
}

export function selectCases(
  b: Battery,
  cycleIndex: number,
  quarantined: Set<string> = new Set(),
): BatteryCase[] {
  const slot = ((cycleIndex % 3) + 3) % 3;
  return b.cases.filter((c) => {
    if (!scorable(c) || quarantined.has(c.id)) return false;
    if (c.cost !== 'heavy') return true;
    if (c.rotation === 'always') return true;
    const r = c.rotation === undefined ? 0 : Number(c.rotation);
    return Number.isInteger(r) && r === slot;
  });
}

/** Casos que no puntuan y por que, para el informe a Nico. */
export function unscored(
  b: Battery,
  quarantined: Set<string> = new Set(),
): { id: string; why: string }[] {
  return b.cases.flatMap((c) => {
    if (c.enabled === false)
      return [{ id: c.id, why: `desactivado: ${c.enableWhen ?? 'sin motivo'}` }];
    if (quarantined.has(c.id))
      return [{ id: c.id, why: 'servicio externo roto 3 ciclos seguidos: revision manual' }];
    if (!scorable(c)) return [{ id: c.id, why: 'sin criterio verificable por maquina: revision' }];
    return [];
  });
}
